import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { routeMessage, admitMessage } from '../src/chat/routing.js';
import { jstDay, budgetStatus, reserveTurn, settleTurn, resetDailyBudget, DailyBudget } from '../src/chat/budget.js';
import { splitMessage, sendText, api, messageText } from '../src/chat/api.js';
import { Conversation, readCost } from '../src/chat/conversation.js';
import { DiscordGateway } from '../src/chat/gateway.js';
import worker from '../src/chat/worker.js';
import { FakeContext, env, input, message } from './helpers.js';

test('only mentions and opted-in threads are routed, with isolated conversation keys', () => {
  const a = routeMessage(message(), '999', { type: 0 }, {}, env);
  assert.equal(a.key, '123:456:789');
  assert.equal(a.text, 'Hello');
  assert.equal(routeMessage(message({ mentions: [] }), '999', { type: 0 }, {}, env), null);
  assert.equal(routeMessage(message({ mentions: [] }), '999', { type: 11 }, {}, env), null);
  const threads = { '456': { expires: Date.now() + 60000 } };
  const b = routeMessage(message({ content: 'Follow-up', mentions: [] }), '999', { type: 11 }, threads, env);
  assert.equal(b.key, '123:456');
  assert.equal(b.text, 'Follow-up');
});

test('ignores other servers, DMs, bots, webhooks, system events, expired threads', () => {
  for (const change of [{ guild_id: '555' }, { guild_id: null }, { author: { id: '789', bot: true } }, { webhook_id: 'w' }, { type: 6 }]) {
    assert.equal(routeMessage(message(change), '999', { type: 11 }, {}, env), null);
  }
  assert.equal(routeMessage(message({ mentions: [] }), '999', { type: 11 }, { '456': { expires: 1 } }, env), null);
});

test('rate limits and durable replay deduplication apply before model calls', () => {
  const state = {};
  assert.equal(admitMessage(state, input(), env), 'accepted');
  assert.equal(admitMessage(state, input(), env), 'duplicate');
  for (let n = 2; n <= 5; n++) assert.equal(admitMessage(state, input(`m${n}`), env), 'accepted');
  assert.equal(admitMessage(state, input('m6'), env), 'limited');
});

test('daily budget reserves across concurrent conversations and fails closed', () => {
  const state = { days: {}, turns: {} };
  for (let n = 0; n < 8; n++) assert.equal(reserveTurn(state, env, `m${n}`).approved, true);
  assert.equal(reserveTurn(state, env, 'm9').approved, false);
  assert.equal(budgetStatus(state, env).reservedCents, 176);
  settleTurn(state, 'm1', 3);
  assert.equal(reserveTurn(state, env, 'm9').approved, true);
  settleTurn(state, 'm1', 100);
  assert.equal(budgetStatus(state, env).accountedCents, 3);
});

test('JST midnight rollover carries in-flight reservations and does not refund unknown outcomes', () => {
  const before = Date.parse('2026-10-15T14:59:59Z'), after = before + 2000;
  const state = { days: {}, turns: {} };
  assert.equal(jstDay(before), '2026-10-15');
  assert.equal(jstDay(after), '2026-10-16');
  reserveTurn(state, env, 'm1', before);
  assert.equal(budgetStatus(state, env, after).reservedCents, 22);
  settleTurn(state, 'm1', 10, after);
  assert.equal(state.days['2026-10-15'], 10);
  assert.equal(state.days['2026-10-16'], 10);
  assert.equal(reserveTurn(state, env, 'm1', after).approved, false);
});

test('temporary reservations can deny a turn then release capacity, distinct from daily exhaustion', () => {
  const state = { days: { [jstDay()]: 150 }, turns: {} };
  assert.equal(reserveTurn(state, env, 'first').approved, true);
  assert.equal(reserveTurn(state, env, 'second').reason, 'budget_reserved');
  settleTurn(state, 'first', 3);
  assert.equal(reserveTurn(state, env, 'second').approved, true);
  settleTurn(state, 'second', 20);
  assert.equal(reserveTurn(state, env, 'third').reason, 'daily_budget');
  assert.equal(budgetStatus(state, env).capCents, 200);
});

test('manual quota reset preserves pending charges and deduplication, and a retry cannot erase new spending', () => {
  const now = Date.parse('2026-10-15T08:00:00Z');
  const state = { days: { '2026-10-15': 160, '2026-10-14': 80 }, turns: {} };
  reserveTurn(state, env, 'pending', now);
  const input = { day: '2026-10-15', requestId: 'manual-reset-test-001' };
  const result = resetDailyBudget(state, env, input, now);
  assert.equal(result.reset.previousAccountedCents, 160);
  assert.equal(result.budget.accountedCents, 0);
  assert.equal(result.budget.reservedCents, 22);
  assert.equal(state.days['2026-10-14'], 80);
  settleTurn(state, 'pending', 5, now);
  assert.equal(reserveTurn(state, env, 'pending', now).approved, false);
  const retry = resetDailyBudget(state, env, input, now);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.budget.accountedCents, 5);
  assert.equal(retry.budget.capCents, 200);
  const before = JSON.stringify(state);
  assert.ok(resetDailyBudget(state, env, { ...input, day: '2026-10-14' }, now).error);
  assert.ok(resetDailyBudget(state, env, { ...input, requestId: '' }, now).error);
  assert.equal(JSON.stringify(state), before);
});

test('quota reset requires admin authentication and POST and persists through the budget object', async () => {
  const ctx = new FakeContext(), budget = new DailyBudget(ctx, env); await ctx.ready;
  budget.state.days[jstDay()] = 169;
  const localEnv = { ...env, CHAT_ADMIN_TOKEN: 'test-admin',
    BUDGET: { getByName: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) } };
  const url = 'https://worker/admin/budget-reset';
  assert.equal((await worker.fetch(new Request(url, { method: 'POST' }), localEnv)).status, 401);
  assert.equal((await worker.fetch(new Request(url, { headers: { Authorization: 'Bearer test-admin' } }), localEnv)).status, 405);
  const response = await worker.fetch(new Request(url, { method: 'POST', headers: { Authorization: 'Bearer test-admin' },
    body: JSON.stringify({ day: jstDay(), requestId: 'manual-reset-http-001' }) }), localEnv);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).budget.remainingCents, 190);
  assert.equal((await ctx.storage.get('ledger')).days[jstDay()], 0);
});

test('Discord output is bounded, Unicode-safe and suppresses all mentions', async t => {
  const text = 'a'.repeat(1899) + '😀' + 'b'.repeat(3000);
  const pieces = splitMessage(text);
  assert.equal(pieces.join(''), text);
  assert.ok(pieces.every(p => p.length <= 1900 && !/[\uD800-\uDBFF]$/.test(p)));
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    bodies.push(JSON.parse(init.body)); return Response.json({ id: 'reply' });
  });
  await sendText(env, '456', text, 'stable-key', 'm1');
  const first = bodies[0].nonce;
  await sendText(env, '456', text, 'stable-key', 'm1');
  assert.equal(bodies[pieces.length].nonce, first);
  assert.deepEqual(bodies[0].allowed_mentions, { parse: [], replied_user: false });
  assert.ok(bodies.every(b => b.enforce_nonce));
  assert.ok(bodies.every(b => b.flags === 4), 'Suppress website previews');
});

test('upstream errors do not reveal secret headers, URLs or response bodies', async () => {
  await assert.rejects(api('https://test.invalid/secret', { headers: { Authorization: 'secret' } }, 'Claude', async () => new Response('secret', { status: 401 })),
    error => error.message === 'Claude HTTP 401');
  assert.throws(() => readCost({ usage: {} }), /Missing session usage/);
});

test('citation-separated text blocks preserve sentences and deliberate paragraph breaks', () => {
  assert.equal(messageText([{ type: 'text', text: '這套牌會' }, { type: 'text', text: '強化守護從者' },
    { type: 'text', text: '。\n\n接著穩住場面。' }, { type: 'tool_use', name: 'web_search' }]),
  '這套牌會強化守護從者。\n\n接著穩住場面。');
});

async function harness(t, answers = [], options = {}) {
  const budgetCtx = new FakeContext();
  const budget = new DailyBudget(budgetCtx, env);
  await budgetCtx.ready;
  const localEnv = { ...env, BUDGET: { getByName: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) } };
  const ctx = new FakeContext();
  const conversation = new Conversation(ctx, localEnv);
  await ctx.ready;
  const calls = [], replies = [], events = [], finalIndexes = new Map();
  let discordSequence = 0;
  let sequence = 0, usage = 0, autoAnswer = true, sessionCount = 0, sessionBudget, sessionTools = [{ type: 'agent_toolset_20260401' }], resumeRunning = false, completion;
  const stamp = () => `2026-10-15T05:00:${String(++sequence).padStart(2, '0')}.000Z`;
  t.mock.method(globalThis, 'fetch', async (raw, init = {}) => {
    const url = new URL(raw), body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method: init.method, body });
    if (url.hostname === 'gamewith.jp') return new Response('<main><h1>規則說明</h1><p>' + '規則正文。'.repeat(40) + '</p></main>', { headers: { 'Content-Type': 'text/html' } });
    if (url.hostname === 'cdn.discordapp.com') return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64'), { headers: { 'Content-Type': 'image/png' } });
    if (url.hostname === 'discord.com') {
      const id = init.method === 'PATCH' ? url.pathname.split('/').at(-1) : `discord_${++discordSequence}`;
      if (body?.content && !['收到，我先看看。', '收到，前一則處理完就接著看這則。'].includes(body.content) && !body.content.startsWith('處理中｜')) {
        if (finalIndexes.has(id)) replies[finalIndexes.get(id)] = body.content;
        else { finalIndexes.set(id, replies.length); replies.push(body.content); }
      }
      return Response.json({ id });
    }
    if (url.pathname === '/v1/sessions' && init.method === 'POST') {
      if (body.agent.type === 'agent_with_overrides' && body.agent.tools?.length === 0) {
        completion = { id: 'sesn_completion', status: 'idle', budget: body.budget, events: [], usage: { list_cost: { currency: 'USD', amount: '0' } } };
        return Response.json({ id: completion.id });
      }
      sessionCount++;
      if (body.agent.tools) sessionTools = body.agent.tools;
      sessionBudget = body.budget;
      if (sessionCount > 1) usage = 0;
      events.push({ id: 'initial-idle', type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: stamp() });
      return Response.json({ id: sessionCount === 1 ? 'sesn_test' : `sesn_test_${sessionCount}` });
    }
    if (url.pathname.startsWith('/v1/sessions/sesn_completion')) {
      if (init.method === 'DELETE') return new Response(null,{status:204});
      if (url.pathname.endsWith('/events')) {
        if (init.method === 'POST') {
          // The live Sessions API requires system.message to be the final event.
          assert.ok(body.events.every((e, i) => e.type !== 'system.message' || i === body.events.length - 1));
          const submitted = body.events.map(e=>({...e,id:`completion_${sequence}`,processed_at:stamp()}));
          completion.events.push(...submitted,
            {id:'completed',type:'agent.message',content:[{type:'text',text:answers.shift() || '整理後的繁中答案'}],processed_at:stamp()},
            {id:'completion-idle',type:'session.status_idle',stop_reason:{type:options.completionBudgetReached ? 'budget_reached' : 'end_turn'},processed_at:stamp()});
          completion.usage.list_cost.amount='2';
          if (options.loseCompletionResponse) { options.loseCompletionResponse=false; throw Error('Lost completion response'); }
          return Response.json({data:submitted});
        }
        return Response.json({data:completion.events,next_page:null});
      }
      return Response.json(completion);
    }
    if (url.pathname.endsWith('/events') && init.method === 'POST') {
      if (options.rejectImages && body.events[0].content?.some(b => b.type === 'image')) return new Response(null, { status: 400 });
      const accepted = [];
      for (const submitted of body.events) {
      const event = { ...submitted, id: `user_${sequence}`, processed_at: stamp() };
      events.push(event); accepted.push(event);
      if (event.type === 'user.interrupt') {
        resumeRunning = false;
        events.push({ id: `idle_${sequence}`, type: 'session.status_idle', processed_at: stamp(), stop_reason: { type: 'interrupted' } });
      }
      if (event.type === 'user.custom_tool_result' && options.loseToolResponse) {
        options.loseToolResponse = false;
        throw Error('Connection lost after acceptance');
      }
      if (autoAnswer && event.type === 'user.message') {
        events.push({ id: `reply_${sequence}`, type: 'agent.message', processed_at: stamp(), content: [{ type: 'text', text: answers.shift() || `Answer ${sequence}` }] });
        events.push({ id: `idle_${sequence}`, type: 'session.status_idle', processed_at: stamp(), stop_reason: { type: 'end_turn' } });
        usage += 2;
      }
      }
      return Response.json({ data: accepted });
    }
    if (url.pathname.endsWith('/events')) {
      const since = url.searchParams.get('created_at[gte]');
      return Response.json({ data: events.filter(e => !since || e.processed_at >= since), next_page: null });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    assert.ok(['GET', 'POST'].includes(init.method), 'Session updates must use POST');
    if (body?.budget) sessionBudget = body.budget;
    if (body?.agent?.tools) sessionTools = body.agent.tools;
    if (options.resumeAtCap && body?.agent?.tools?.length === 0) {
      resumeRunning = true;
      events.push({ id: `reply_${sequence}`, type: 'agent.message', processed_at: stamp(), content: [{ type: 'text', text: '舊研究草稿' }] });
      events.push({ id: `idle_${sequence}`, type: 'session.status_idle', processed_at: stamp(), stop_reason: { type: 'end_turn' } });
      usage += 2;
    }
    return Response.json({ id: 'sesn_test', status: resumeRunning ? 'running' : 'idle', budget: sessionBudget, agent: { tools: sessionTools }, usage: { list_cost: { currency: 'USD', amount: String(usage) } } });
  });
  const enqueue = data => conversation.fetch(new Request('https://conversation/message', { method: 'POST', body: JSON.stringify(data) }));
  return { conversation, ctx, localEnv, budget, calls, replies, events, enqueue, setAutoAnswer: value => { autoAnswer = value; }, setUsage: value => { usage = value; } };
}

test('two conversational turns reuse the pinned agent session and never replay old answers', async t => {
  const h = await harness(t);
  await h.enqueue(input('m1'));
  await h.conversation.alarm();
  assert.equal(h.replies.length, 1);
  assert.equal(h.conversation.state.current, null);
  await h.enqueue(input('m2', { text: 'Follow up' }));
  await h.conversation.alarm();
  assert.equal(h.replies.length, 2);
  const creates = h.calls.filter(c => c.path === '/v1/sessions' && c.method === 'POST');
  assert.equal(creates.length, 1);
  const createdAgent = creates[0].body.agent;
  assert.equal(createdAgent.type, 'agent_with_overrides');
  assert.equal(createdAgent.id, 'agent_test'); assert.equal(createdAgent.version, 1);
  assert.ok(createdAgent.tools.some(tool => tool.name === 'make_custom_card'));
  assert.equal(creates[0].body.budget.max_list_cost.amount, '20');
  assert.ok(h.calls.some(c => c.path === '/v1/sessions/sesn_test' && c.method === 'POST' && c.body.budget.max_list_cost.amount === '22'));
  assert.equal(budgetStatus(h.budget.state, env).accountedCents, 6);
  assert.equal(budgetStatus(h.budget.state, env).reservedCents, 0);
  await h.enqueue(input('m2'));
  assert.equal(h.conversation.state.queue.length, 0);
});

test('accepted messages only type until there is content; short answers create one message after restart', async t => {
  const h = await harness(t, ['完整答案']);
  await h.enqueue(input('early'));
  assert.ok(!h.calls.some(c => c.path.startsWith('/v1/sessions')));
  assert.ok(h.calls[0].path.endsWith('/typing'));
  const saved = await h.ctx.storage.get('conversation');
  assert.equal(saved.queue[0].progressMessageId, undefined);
  await h.enqueue(input('early'));
  assert.equal(h.calls.filter(c => c.path.endsWith('/messages')).length,0);
  const restarted = new Conversation(h.ctx,h.localEnv); await h.ctx.ready; await restarted.alarm();
  assert.equal(h.calls.filter(c => c.path.endsWith('/messages')).length,1);
  assert.equal(h.calls.filter(c => c.method === 'PATCH').length,0);
  assert.deepEqual(h.replies,['完整答案']);
});

test('useful interim findings edit the same message, coalesce rapid updates and keep final answers separate', async t => {
  const h=await harness(t); h.setAutoAnswer(false);
  await h.enqueue(input('progress')); await h.conversation.alarm();
  h.events.push({id:'progress-tool',type:'agent.custom_tool_use',name:'report_svwb_progress',input:{message:'已確認卡包範圍，正在核對完整名單。'},processed_at:'2026-10-15T05:01:00Z'},
    {id:'progress-wait',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:['progress-tool']},processed_at:'2026-10-15T05:01:01Z'});
  await h.conversation.alarm();
  let edits=h.calls.filter(c=>c.method==='PATCH');
  assert.equal(edits.length,0);
  assert.match(h.calls.find(c=>c.path.endsWith('/messages')).body.content,/已確認卡包範圍/);
  assert.equal(h.conversation.state.current.phase,'poll');
  await h.conversation.progress('已核對一半。'); await h.conversation.progress('已核對全部，正在整理。');
  assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);
  h.conversation.state.current.progressAt=Date.now()-16000; await h.conversation.save();
  const restarted=new Conversation(h.ctx,h.localEnv); await h.ctx.ready; await restarted.alarm();
  edits=h.calls.filter(c=>c.method==='PATCH'); assert.equal(edits.length,1); assert.match(edits[0].body.content,/已核對全部/);
  h.events.push({id:'final-progress',type:'agent.message',content:[{type:'text',text:'完整正式答案。'}],processed_at:'2026-10-15T05:02:00Z'},
    {id:'done-progress',type:'session.status_idle',stop_reason:{type:'end_turn'},processed_at:'2026-10-15T05:02:01Z'});
  await restarted.alarm();
  assert.deepEqual(h.replies,['完整正式答案。']);
  assert.equal(new Set(h.calls.filter(c=>c.method==='PATCH').map(c=>c.path)).size,1);
  assert.equal(h.calls.filter(c=>c.path.endsWith('/messages')).length,1);
});

test('deleted progress messages fall back to a final POST and long answers keep every chunk', async t => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    calls.push({url,method:init.method,body:JSON.parse(init.body)});
    return init.method==='PATCH' ? new Response(null,{status:404}) : Response.json({id:'final'});
  });
  const text='正式答案'.repeat(1000);
  await sendText(env,'456',text,'answer','user-message','deleted-progress');
  assert.equal(calls[0].method,'PATCH');
  const posts=calls.filter(c=>c.method==='POST');
  assert.equal(posts.map(c=>c.body.content).join(''),text);
  assert.ok(posts.every(c=>c.body.enforce_nonce && !c.body.allowed_mentions.parse.length));
  assert.equal(posts[0].body.message_reference.message_id,'user-message');
});

test('budget denial directly sends one notice without an acknowledgement', async t => {
  const h=await harness(t); h.budget.state.days[jstDay()]=190;
  await h.enqueue(input('denied')); await h.conversation.alarm();
  assert.equal(h.calls.filter(c=>c.path.endsWith('/messages')).length,1);
  assert.match(h.calls.find(c=>c.path.endsWith('/messages')).body.content,/AI 預算/);
  assert.equal(h.conversation.state.current,null);
});

test('a lost initial finding response retries with the same nonce and never stops research', async t => {
  const h=await harness(t); h.setAutoAnswer(false);
  const original=globalThis.fetch;
  const attempts=[];
  t.mock.method(globalThis,'fetch',async(raw,init)=>{
    if(String(raw).endsWith('/messages')) { attempts.push(JSON.parse(init.body)); if(attempts.length===1) throw new TypeError('Lost response'); }
    return original(raw,init);
  });
  await h.enqueue(input('retry-progress')); await h.conversation.alarm();
  await h.conversation.progress('這張卡的費用是3。');
  assert.equal(h.conversation.state.current.input.progressMessageId,undefined);
  h.conversation.state.current.progressAt=Date.now()-6000;
  await h.conversation.progress();
  assert.equal(attempts.length,2);assert.equal(attempts[0].nonce,attempts[1].nonce);
  assert.ok(h.conversation.state.current.input.progressMessageId);assert.equal(h.conversation.state.blocked,undefined);
});

test('ordinary public findings between reads are delivered without the optional progress tool', async t => {
  const h=await harness(t); h.setAutoAnswer(false);
  await h.enqueue(input('natural-progress')); await h.conversation.alarm();
  h.events.push({id:'plan',type:'agent.message',content:[{type:'text',text:'我先查一下。'}],processed_at:'2026-10-15T05:01:00Z'},
    {id:'read-one',type:'agent.custom_tool_use',name:'read_svwb_source',input:{url:'https://gamewith.jp/shadowverse-wb/123'},processed_at:'2026-10-15T05:01:01Z'});
  await h.conversation.alarm();
  assert.equal(h.calls.filter(c=>c.path.endsWith('/messages')).length,0,'Initial plan is not an answer');
  h.events.push({id:'finding',type:'agent.message',content:[{type:'thinking',thinking:'PRIVATE'}, {type:'text',text:'已確認這項能力只在自己的回合發動；下一步會核對觸發條件。'}],processed_at:'2026-10-15T05:01:02Z'},
    {id:'read-two',type:'agent.custom_tool_use',name:'read_svwb_source',input:{url:'https://gamewith.jp/shadowverse-wb/456'},processed_at:'2026-10-15T05:01:03Z'});
  await h.conversation.alarm();
  assert.equal(h.calls.filter(c=>c.path.endsWith('/messages')).length,1);
  assert.match(h.replies[0],/自己的回合/);assert.ok(!h.replies[0].includes('PRIVATE'));
  const restarted=new Conversation(h.ctx,h.localEnv);await h.ctx.ready;
  restarted.state.current.progressAt=Date.now()-6000;
  h.events.push({id:'finding-two',type:'agent.message',content:[{type:'text',text:'已核對兩個來源：只有自己的回合，而且必須先進化。'}],processed_at:'2026-10-15T05:01:04Z'},
    {id:'read-three',type:'agent.tool_use',name:'web_search',processed_at:'2026-10-15T05:01:05Z'});
  await restarted.alarm();
  assert.equal(h.calls.filter(c=>c.method==='PATCH').length,1);assert.match(h.replies[0],/必須先進化/);
  h.events.push({id:'natural-final',type:'agent.message',content:[{type:'text',text:'最後確認的答案。'}],processed_at:'2026-10-15T05:01:06Z'},
    {id:'natural-done',type:'session.status_idle',stop_reason:{type:'end_turn'},processed_at:'2026-10-15T05:01:07Z'});
  await restarted.alarm();
  assert.deepEqual(h.replies,['最後確認的答案。']);assert.equal(h.calls.filter(c=>c.path.endsWith('/messages')).length,1);
});

const imageInput = () => ({ images: [{ id: '111', messageId: 'm1', channelId: '456', filename: 'deck.png',
  mediaType: 'image/png', source: 'upload', url: 'https://cdn.discordapp.com/attachments/456/111/deck.png' }] });

test('image pixels reach the model within the same budget and are never persisted in the queue', async t => {
  const h = await harness(t); h.setAutoAnswer(false);
  await h.enqueue(input('image', imageInput())); await h.conversation.alarm();
  const sends = h.calls.filter(c => c.path.endsWith('/events') && c.method === 'POST');
  assert.equal(sends[0].body.events[0].content.filter(b => b.type === 'image').length, 1);
  assert.match(sends[0].body.events[0].content[0].text, /"status":"loaded"/);
  assert.ok(!JSON.stringify([...h.ctx.data]).includes('iVBORw0KGgo'), 'Do not persist base64 in Durable Object values');
  h.conversation.state.current.phase = 'sending'; delete h.conversation.state.current.userEventId;
  await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase, 'poll');
  assert.equal(h.calls.filter(c => c.path.endsWith('/events') && c.method === 'POST').length, 1, 'Reconcile an uncertain image submission without duplication');
  assert.equal(h.calls.filter(c => c.body?.budget).length, 1);
});

test('rejected image payload falls back once with an honest failure report and no cap increase', async t => {
  const h = await harness(t, ['圖片讀取失敗，請重傳。'], { rejectImages: true });
  await h.enqueue(input('image', imageInput())); await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase, 'send');
  await h.conversation.alarm();
  assert.equal(h.conversation.state.current, null); assert.equal(h.conversation.state.blocked, undefined);
  assert.match(h.replies[0], /讀取失敗/);
  const sends = h.calls.filter(c => c.path.endsWith('/events') && c.method === 'POST');
  assert.equal(sends.length, 2); assert.equal(sends[1].body.events[0].content.length, 1);
  assert.match(sends[1].body.events[0].content[0].text, /"status":"unavailable"/);
  assert.equal(h.calls.filter(c => c.body?.budget).length, 1);
  assert.equal(h.conversation.state.imageCount, 0);
});

test('image requests cannot download or generate when the daily budget is exhausted', async t => {
  const h = await harness(t); h.budget.state.days[jstDay()] = 200;
  await h.enqueue(input('image', imageInput())); await h.conversation.alarm();
  assert.ok(!h.calls.some(c => c.path.startsWith('/attachments/') || c.path.startsWith('/v1/sessions')));
});

test('image-count rollover summarizes first, then sends new pixels only to the successor session', async t => {
  const h = await harness(t, ['已看過圖片', '摘要：龍族牌組，卡名有不確定的部分。', '收到新圖片']);
  await h.enqueue(input('old')); await h.conversation.alarm();
  h.conversation.state.imageCount = 16;
  await h.enqueue(input('new', imageInput())); await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase, 'rotate');
  const summary = h.calls.filter(c => c.path.endsWith('/events') && c.method === 'POST').at(-1).body.events[0];
  assert.equal(summary.content.length, 1);
  await h.conversation.alarm();
  assert.equal(h.conversation.state.sessionId, 'sesn_test_2'); assert.equal(h.conversation.state.imageCount, 1);
  assert.equal(h.conversation.state.current, null);
});

test('foreign search prose is withheld and rewritten once within the original budget', async t => {
  const foreign = '龍族的特色是PPの最大値を増やせるPPブーストが得意なこと。シャドバの最強デッキです。';
  const h = await harness(t, [foreign, '跳費龍會先增加 PP 上限，再用高費從者取得優勢。']);
  await h.enqueue(input('language', { text: '怎麼玩跳費龍', meta: null }));
  await h.conversation.alarm();
  assert.equal(h.replies.length, 0, 'Do not publish the untranslated draft');
  assert.equal(h.conversation.state.current.phase, 'send');
  await h.conversation.alarm();
  assert.deepEqual(h.replies, ['跳費龍會先增加 PP 上限，再用高費從者取得優勢。']);
  assert.equal(h.conversation.state.current, null);
  assert.equal(h.calls.filter(c => c.body?.budget).length, 1, 'Repair cannot increase the session cap');
  assert.equal(budgetStatus(h.budget.state, env).accountedCents, 5);
});

for (const trigger of ['tokens', 'idle']) test(`automatic summary rollover preserves context and one reservation (${trigger})`, async t => {
  const h = await harness(t, ['收到，牌組是 y8hf，預算 3000。', '使用者的牌組 y8hf，合成預算 3000，不換職業。', '你的合成預算是 3000。']);
  await h.enqueue(input('before')); await h.conversation.alarm();
  if (trigger === 'tokens') h.conversation.state.contextTokens = 81000;
  else { h.conversation.state.contextTokens = 100; h.conversation.state.lastTurnAt = Date.now() - 31 * 60000; }
  await h.enqueue(input('after', { text: '還記得我的預算嗎？' })); await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase, 'rotate');
  assert.equal(h.replies.length, 1, 'Summary is internal, not a reply');
  assert.equal(h.conversation.state.sessionId, 'sesn_test', 'Old session remains until summary is saved');
  h.conversation = new Conversation(h.ctx, h.localEnv); await h.ctx.ready;
  h.enqueue = data => h.conversation.fetch(new Request('https://conversation/message', { method: 'POST', body: JSON.stringify(data) }));
  await h.conversation.alarm();
  assert.equal(h.conversation.state.current, null);
  assert.equal(h.conversation.state.sessionId, 'sesn_test_2');
  assert.deepEqual(h.conversation.state.retiredSessions, ['sesn_test']);
  assert.deepEqual(h.replies, ['收到，牌組是 y8hf，預算 3000。', '你的合成預算是 3000。']);
  const lastUser = h.calls.filter(c => c.path.endsWith('/events') && c.method === 'POST').at(-1).body.events[0].content[0].text;
  assert.match(lastUser, /previous_conversation_summary/);
  assert.match(lastUser, /y8hf/);
  const create = h.calls.filter(c => c.path === '/v1/sessions').at(-1);
  assert.equal(create.body.budget.max_list_cost.amount, '17');
  assert.equal(budgetStatus(h.budget.state, env).accountedCents, 9, 'Both sessions and rounding guards are charged');
  assert.equal(budgetStatus(h.budget.state, env).reservedCents, 0);
  await h.enqueue(input('clear', { command: 'reset' })); await h.conversation.alarm();
  assert.deepEqual(h.calls.filter(c => c.method === 'DELETE').map(c => c.path).sort(), ['/v1/sessions/sesn_test', '/v1/sessions/sesn_test_2']);
  assert.equal(h.conversation.state.summary, undefined);
});

test('a failed language rewrite stops after one retry and never sends the foreign draft', async t => {
  const foreign = 'This deck is very powerful because it can play large followers earlier than other decks.';
  const h = await harness(t, [foreign, foreign]);
  await h.enqueue(input('language')); await h.conversation.alarm(); await h.conversation.alarm();
  assert.equal(h.conversation.state.current, null);
  assert.equal(h.calls.filter(c => c.path.endsWith('/events') && c.method === 'POST').length, 2);
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0], /繁體中文/);
  assert.ok(!h.replies[0].includes('This deck'));
});

test('an explicit request for an English answer bypasses the default-language guard', async t => {
  const english = 'This deck is very powerful because it can play large followers earlier than other decks.';
  const h = await harness(t, [english]);
  await h.enqueue(input('language', { text: '請用英文回答 SVWB 的玩法' })); await h.conversation.alarm();
  assert.deepEqual(h.replies, [english]);
  assert.equal(h.conversation.state.current, null);
});

test('initial idle and prior turn history cannot finish or duplicate a pending reply', async t => {
  const h = await harness(t);
  await h.enqueue(input('m1')); await h.conversation.alarm();
  h.setAutoAnswer(false);
  await h.enqueue(input('m2')); await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase, 'poll');
  await h.conversation.alarm();
  assert.equal(h.replies.length, 1);
  assert.equal(h.conversation.state.current.phase, 'poll');
});

test('uncertain send recovers from persisted event history without submitting twice', async t => {
  const h = await harness(t);
  await h.enqueue(input('m1')); h.setAutoAnswer(false); await h.conversation.alarm();
  const job = h.conversation.state.current;
  job.phase = 'sending'; delete job.userEventId;
  const before = h.calls.filter(c => c.path.endsWith('/events') && c.method === 'POST').length;
  await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase, 'poll');
  assert.equal(h.calls.filter(c => c.path.endsWith('/events') && c.method === 'POST').length, before);
});

test('budget denial makes no Claude generation request', async t => {
  const h = await harness(t);
  h.budget.state.days[jstDay()] = 200;
  await h.enqueue(input()); await h.conversation.alarm();
  assert.equal(h.calls.filter(c => c.path.startsWith('/v1/sessions')).length, 0);
  assert.match(h.replies[0], /AI 預算/);
});

test('only conversation starter can clear shared thread history', async t => {
  const h = await harness(t);
  await h.enqueue(input('m1', { thread: true })); await h.conversation.alarm();
  await h.enqueue(input('m2', { thread: true, command: 'reset', authorId: 'other' }));
  assert.match(h.replies.at(-1), /只有開啟/);
  assert.equal(h.conversation.state.sessionId, 'sesn_test');
  await h.enqueue(input('m3', { thread: true, command: 'reset' })); await h.conversation.alarm();
  assert.equal(h.conversation.state.sessionId, undefined);
  assert.ok(h.calls.some(c => c.method === 'DELETE'));
});

test('a new speaker joining a reply reuses the original session and cannot reset its history',async t=>{
 const h=await harness(t,['原作者的答案','接續原話題的答案']);
 await h.enqueue(input('a'));await h.conversation.alarm();
 await h.enqueue(input('b',{authorId:'person-b',authorName:'Second',sharedReply:true,conversationOwnerId:'789'}));await h.conversation.alarm();
 assert.equal(h.calls.filter(c=>c.path==='/v1/sessions'&&c.method==='POST').length,1);
 const users=h.calls.flatMap(c=>c.body?.events||[]).filter(e=>e.type==='user.message');
 assert.ok(users.at(-1).content[0].text.includes('"id":"person-b"'));
 assert.equal(h.conversation.state.ownerId,'789');
 await h.enqueue(input('b-reset',{authorId:'person-b',sharedReply:true,conversationOwnerId:'789',command:'reset'}));
 assert.match(h.replies.at(-1),/只有開啟/);assert.equal(h.conversation.state.sessionId,'sesn_test');
});

test('Gateway heartbeat/resume uses the persisted sequence', async () => {
  const ctx = new FakeContext();
  const gateway = new DiscordGateway(ctx, env); await ctx.ready;
  const sent = [];
  gateway.socket = { send: raw => sent.push(JSON.parse(raw)), close() {} };
  gateway.state.resume = { id: 'gateway_session', url: 'wss://gateway.discord.gg', seq: 42 };
  gateway.latestSequence = 42;
  gateway.acknowledged = true;
  await gateway.packet({ op: 10, d: { heartbeat_interval: 45000 } });
  assert.equal(sent[0].op, 6);
  assert.equal(sent[0].d.seq, 42);
  gateway.heartbeat(); assert.deepEqual(sent.at(-1), { op: 1, d: 42 });
  gateway.heartbeat(); assert.equal(gateway.socket, null);
});

test('public admin endpoints cannot start the bot without the secret', async () => {
  const response = await worker.fetch(new Request('https://chat/admin/start', { method: 'POST' }), { CHAT_ADMIN_TOKEN: 'secret' });
  assert.equal(response.status, 401);
});

test('a mention added by a partial edit is accepted once, with normal routing and replay protection', async t => {
  const ctx = new FakeContext(), delivered = [], requests = [];
  const localEnv = { ...env, CONVERSATIONS: { getByName: () => ({ fetch: async (url, init) => {
    delivered.push(JSON.parse(init.body)); return Response.json({ accepted: true });
  } }) } };
  const gateway = new DiscordGateway(ctx, localEnv); await ctx.ready;
  gateway.state.enabled = true; gateway.state.botId = '999';
  let current = message({ content: '<@999> 最近主教有什麼強牌嗎' });
  t.mock.method(globalThis, 'fetch', async raw => {
    const path = new URL(raw).pathname; requests.push(path);
    return Response.json(path.endsWith('/messages/m1') ? current : { type: 0 });
  });
  await gateway.packet({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: message({ content: '最近主教有什麼強牌嗎', mentions: [] }) });
  assert.equal(delivered.length, 0);
  const update = { id: 'm1', guild_id: '123', channel_id: '456', content: current.content,
    edited_timestamp: '2026-10-15T06:08:24Z' };
  await gateway.packet({ op: 0, t: 'MESSAGE_UPDATE', s: 2, d: update });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, '最近主教有什麼強牌嗎');
  assert.equal(delivered[0].authorId, '789');
  const count = requests.length;
  await gateway.packet({ op: 0, t: 'MESSAGE_UPDATE', s: 3, d: update });
  assert.equal(delivered.length, 1);
  assert.equal(requests.length, count);
});

test('edit handling skips embed-only updates, other guilds and fetched bot messages', async t => {
  const ctx = new FakeContext(), gateway = new DiscordGateway(ctx, env); await ctx.ready;
  gateway.state.botId = '999';
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++; return Response.json(message({ author: { id: 'bot', bot: true } }));
  });
  const update = { id: 'm1', channel_id: '456', guild_id: '123', content: '<@999> Hello', edited_timestamp: '2026-10-15T06:08:24Z' };
  await gateway.receiveEdit({ ...update, content: undefined });
  await gateway.receiveEdit({ ...update, guild_id: 'other' });
  assert.equal(requests, 0);
  await gateway.receiveEdit(update);
  assert.equal(requests, 1);
  assert.equal(gateway.state.pending.length, 0);
});

test('mentioning the bot-managed role routes reset but unrelated roles do not', async t => {
  const ctx = new FakeContext(), gateway = new DiscordGateway(ctx, env); await ctx.ready;
  gateway.state.botId = '999';
  let roleFetches = 0;
  t.mock.method(globalThis, 'fetch', async raw => {
    if (new URL(raw).pathname.endsWith('/messages/edited-role')) return Response.json(message({ id: 'edited-role', content: '<@&777> reset', mentions: [], mention_roles: ['777'] }));
    if (new URL(raw).pathname.endsWith('/roles')) {
      roleFetches++;
      return Response.json([{ id: '777', managed: true, tags: { bot_id: '999' } }, { id: '888', name: 'Other' }]);
    }
    return Response.json({ type: 0 });
  });
  await gateway.receive(message({ id: 'other-role', content: '<@&888> reset', mentions: [], mention_roles: ['888'] }));
  assert.equal(gateway.state.pending.length, 0);
  await gateway.receive(message({ content: '<@&777> reset', mentions: [], mention_roles: ['777'] }));
  assert.equal(gateway.state.pending.length, 1);
  assert.equal(gateway.state.pending[0].command, 'reset');
  await gateway.receiveEdit({ id: 'edited-role', guild_id: '123', channel_id: '456', content: '<@&777> reset', edited_timestamp: '2026-10-15T06:08:24Z' });
  assert.equal(gateway.state.pending.length, 2);
  assert.equal(gateway.state.pending[1].command, 'reset');
  assert.equal(roleFetches, 1);
});

test('agent spec pins Haiku 5.5 and only enables web tools', async () => {
  const spec = JSON.parse(await readFile(new URL('../claude/agent.json', import.meta.url), 'utf8'));
  assert.equal(spec.model.id, 'claude-haiku-5-5');
  assert.equal(spec.model.effort.type, 'high');
  assert.equal(spec.tools[0].default_config.enabled, false);
  assert.deepEqual(spec.tools[0].configs.map(c => c.name), ['web_search', 'web_fetch']);
  assert.deepEqual(spec.tools.slice(1).map(c => c.name), ['read_svwb_source', 'query_svwb_data', 'report_svwb_progress']);
  assert.equal(spec.multiagent, undefined);
});

test('custom research resumes through requires_action and retries ambiguous results without extra budget', async t => {
  const h = await harness(t, [], { loseToolResponse: true }); h.setAutoAnswer(false);
  await h.enqueue(input('research')); await h.conversation.alarm();
  h.events.push({ id: 'progress', type: 'agent.message', processed_at: '2026-10-15T05:01:00Z', content: [{ type: 'text', text: '我先查一下。' }] },
    { id: 'tool1', type: 'agent.custom_tool_use', name: 'read_svwb_source', input: { url: 'https://gamewith.jp/shadowverse-wb/123' }, processed_at: '2026-10-15T05:01:01Z' },
    { id: 'wait-tool', type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['tool1'] }, processed_at: '2026-10-15T05:01:02Z' });
  await h.conversation.alarm();
  assert.equal(h.conversation.state.current.toolResults.tool1.sent, false);
  h.conversation = new Conversation(h.ctx, h.localEnv); await h.ctx.ready;
  await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase, 'poll');
  assert.equal(h.conversation.state.blocked, undefined);
  const results = h.calls.filter(c => c.body?.events?.[0]?.type === 'user.custom_tool_result');
  assert.equal(results.length, 2); assert.ok(results.every(c => c.body.events[0].custom_tool_use_id === 'tool1'));
  assert.equal(JSON.parse(results[0].body.events[0].content[0].text).status, 'ok');
  assert.ok(!JSON.stringify([...h.ctx.data]).includes('規則正文'), 'Do not accumulate source bodies in Durable Object storage');
  h.events.push({ id: 'final', type: 'agent.message', content: [{ type: 'text', text: '已確認規則，這是具體答案。' }], processed_at: '2026-10-15T05:01:03Z' },
    { id: 'done', type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: '2026-10-15T05:01:04Z' });
  await h.conversation.alarm();
  assert.deepEqual(h.replies, ['已確認規則，這是具體答案。']);
  assert.equal(h.calls.filter(c => c.body?.budget).length, 1);
  assert.equal(budgetStatus(h.budget.state, env).reservedCents, 0);
});

test('existing conversations receive new tools without replacing their session or history', async t => {
  const h = await harness(t); await h.enqueue(input('old')); await h.conversation.alarm();
  delete h.conversation.state.researchToolsVersion;
  delete h.conversation.state.researchPolicyVersion;
  h.conversation.state.funToolsVersion = 1;
  await h.enqueue(input('next')); await h.conversation.alarm();
  assert.equal(h.calls.filter(c => c.path === '/v1/sessions' && c.method === 'POST').length, 1);
  const update = h.calls.find(c => c.path === '/v1/sessions/sesn_test' && c.body?.agent?.tools);
  assert.ok(update.body.agent.tools.some(t => t.name === 'read_svwb_source'));
  assert.ok(update.body.agent.tools.some(t => t.name === 'roll_dice'));
  assert.ok(update.body.agent.tools.some(t => t.name === 'make_custom_card'));
  assert.equal(h.conversation.state.researchToolsVersion, 7);
  assert.ok(update.body.agent.tools.find(t => t.name === 'query_svwb_data').input_schema.properties.resource.enum.includes('deck_library'));
  assert.ok(update.body.agent.tools.find(t => t.name === 'query_svwb_data').input_schema.properties.resource.enum.includes('terminology'));
  assert.ok(h.calls.some(c => c.body?.events?.at(-1)?.type === 'system.message'));
  assert.ok(h.calls.some(c => c.body?.events?.some(e => e.type === 'system.message' && e.content?.some(b => b.text?.includes('功能與權限更新')))));
  for (const call of h.calls.filter(c => c.body?.events)) assert.ok(call.body.events.filter(e => e.type === 'system.message').length <= 1);
});

test('deployed conversation capabilities report both feature sets and renderer configuration without generation', async t => {
  const h = await harness(t);
  h.localEnv.FUN = { fetch: async (url, init) => {
    assert.equal(url, 'https://fun/v1/cards/render'); assert.equal(init.headers.Authorization, 'Bearer configured');
    return new Response(null, { status: 405 });
  } }; h.localEnv.FUN_API_TOKEN = 'configured';
  const response = await h.conversation.fetch(new Request('https://conversation/capabilities'));
  const status = await response.json();
  assert.equal(status.funVersion, 4); assert.equal(status.progressReplyVersion, 2); assert.equal(status.rendererConfigured, true); assert.equal(status.catalogBatching, true);
  assert.equal(status.rendererAuthenticated, true);
  for (const name of ['read_svwb_source', 'query_svwb_data', 'roll_dice', 'pick_random_card', 'pick_random_craft', 'make_custom_card']) assert.ok(status.tools.includes(name));
  assert.equal(h.calls.length, 0); assert.equal(h.conversation.state.queue.length, 0);
});

test('research exhaustion completes from plain evidence within the remaining allowance and preserves the main conversation', async t => {
  const h = await harness(t, ['已確認的繁中結論與來源。']); h.localEnv.ANSWER_RESERVE_CENTS = '4';
  h.setAutoAnswer(false); await h.enqueue(input('research')); await h.conversation.alarm();
  assert.equal(h.calls.find(c => c.path === '/v1/sessions').body.budget.max_list_cost.amount, '20');
  h.setUsage(16);
  h.events.push({ id: 'pending-read', type: 'agent.custom_tool_use', name: 'query_svwb_data',
    input: { resource: 'terminology', query: 'Invoke' }, processed_at: '2026-10-15T05:00:04.000Z' });
  h.events.push({ id: 'research-cap', type: 'session.status_idle', stop_reason: { type: 'budget_reached' }, processed_at: '2026-10-15T05:00:05.000Z' });
  await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase, 'finalize-stop');
  assert.equal(h.conversation.state.blocked, undefined);
  h.setAutoAnswer(true); await h.conversation.alarm();
  for (let i = 0; i < 8 && h.conversation.state.current; i++) await h.conversation.alarm();
  assert.equal(h.conversation.state.current, null);
  assert.deepEqual(h.replies, ['已確認的繁中結論與來源。']);
  const finish = h.calls.find(c => c.body?.agent?.tools?.length === 0);
  assert.equal(finish.body.budget.max_list_cost.amount, '3');
  assert.equal(finish.body.agent.type, 'agent_with_overrides');
  const finalRequest = h.calls.find(c => c.path === '/v1/sessions/sesn_completion/events' && c.method === 'POST');
  assert.ok(finalRequest.body.events[0].content[0].text.includes('official_snapshot'));
  assert.ok(finalRequest.body.events[0].content[0].text.includes('瞬念召喚'));
  const drained = h.calls.flatMap(c => c.path === '/v1/sessions/sesn_test/events' ? c.body?.events || [] : []).filter(e => e.custom_tool_use_id === 'pending-read');
  assert.ok(drained.every(e => JSON.parse(e.content[0].text).status === 'unavailable'));
  assert.ok(h.calls.some(c => c.body?.events?.[0]?.type === 'user.interrupt'));
  assert.equal(budgetStatus(h.budget.state, env).accountedCents, 20);
  assert.equal(budgetStatus(h.budget.state, env).reservedCents, 0);
  await h.enqueue(input('next')); await h.conversation.alarm();
  assert.equal(h.conversation.state.sessionId,'sesn_test');
  assert.ok(h.calls.some(c => c.path.endsWith('/sesn_completion') && c.method === 'DELETE'));
  assert.ok(h.calls.some(c => c.body?.events?.some(e=>e.content?.some(b=>b.text?.includes('previous_assistant_answer')))));
});

test('long drafts are edited once within the original budget before being published', async t => {
  const h = await harness(t, ['研究草稿。'.repeat(80), '試試這套。先留低費從者，依場面決定進化時機。']);
  h.localEnv.ANSWER_RESERVE_CENTS = '4';
  await h.enqueue(input('editing')); await h.conversation.alarm();
  assert.equal(h.replies.length, 0);
  assert.equal(h.conversation.state.current.polishing, true);
  for (let i = 0; i < 6 && h.conversation.state.current; i++) await h.conversation.alarm();
  assert.deepEqual(h.replies, ['試試這套。先留低費從者，依場面決定進化時機。']);
  const editors = h.calls.filter(c => c.body?.agent?.tools?.length === 0);
  assert.equal(editors.length, 1);
  assert.equal(editors[0].body.budget.max_list_cost.amount, '6');
  assert.equal(h.conversation.state.sessionId, 'sesn_test');
  assert.ok(budgetStatus(h.budget.state, env).accountedCents <= 20);
  assert.equal(budgetStatus(h.budget.state, env).reservedCents, 0);
});

test('an optional edit that runs out of budget preserves the completed original answer', async t => {
  const draft = '已查證的回答。'.repeat(60);
  const h = await harness(t, [draft, '未完成的編輯'], { completionBudgetReached: true });
  h.localEnv.ANSWER_RESERVE_CENTS = '4';
  await h.enqueue(input('editing-budget')); await h.conversation.alarm();
  for (let i = 0; i < 6 && h.conversation.state.current; i++) await h.conversation.alarm();
  assert.deepEqual(h.replies, [draft]);
  assert.equal(h.conversation.state.sessionId, 'sesn_test');
  assert.equal(budgetStatus(h.budget.state, env).reservedCents, 0);
});

test('a final writer repairs Japanese labels once within its existing session allowance', async t => {
  const h = await harness(t, ['研究草稿。'.repeat(80), '推薦テンポエルフ（ローテ），附上這份牌表。', '推薦這套輪替節奏妖，附上這份牌表。']);
  h.localEnv.ANSWER_RESERVE_CENTS = '4';
  await h.enqueue(input('editing-labels')); await h.conversation.alarm();
  for (let i = 0; i < 9 && h.conversation.state.current; i++) await h.conversation.alarm();
  assert.deepEqual(h.replies, ['推薦這套輪替節奏妖，附上這份牌表。']);
  assert.equal(h.calls.filter(c => c.body?.agent?.tools?.length === 0).length, 1);
  assert.equal(h.calls.filter(c => c.path === '/v1/sessions/sesn_completion/events' && c.method === 'POST').length, 2);
});

test('search-only drafts get one bounded source-reading continuation before delivery', async t => {
  const h = await harness(t, ['已補讀正文，這是答案。']); h.setAutoAnswer(false);
  await h.enqueue(input('search')); await h.conversation.alarm();
  h.events.push({ id: 'search1', type: 'agent.tool_use', name: 'web_search', processed_at: '2026-10-15T05:00:03.000Z' },
    { id: 'draft', type: 'agent.message', content: [{ type: 'text', text: '搜尋摘要說明。' }], processed_at: '2026-10-15T05:00:04.000Z' },
    { id: 'end1', type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: '2026-10-15T05:00:05.000Z' });
  await h.conversation.alarm();
  assert.equal(h.replies.length, 0); assert.equal(h.conversation.state.current.evidenceRepair, true);
  h.setAutoAnswer(true); await h.conversation.alarm();
  // The fake API uses earlier timestamps, so poll directly without a cursor.
  if (h.conversation.state.current) { h.conversation.state.current.since = null; await h.conversation.alarm(); }
  assert.deepEqual(h.replies, ['已補讀正文，這是答案。']);
  assert.equal(h.calls.filter(c => c.body?.budget).length, 1);
});

test('a costly source result after compaction is stopped before it can consume the final-answer allowance', async t => {
  const h = await harness(t, ['下版退環境的龍族卡，依已讀卡包資料列出。']);
  h.localEnv.ANSWER_RESERVE_CENTS = '4';
  h.setAutoAnswer(false); await h.enqueue(input('rotation')); await h.conversation.alarm();
  const job = h.conversation.state.current;
  // Captured production boundary: summary cost left a 16-cent session cap;
  // another model request at 12 cents jumped to 18 before any answer existed.
  job.capCents = 16; job.researchCapCents = 12; job.priorCents = 3;
  h.setUsage(12);
  h.events.push({ id: 'expensive-page', type: 'agent.custom_tool_use', name: 'read_svwb_source', input: { url: 'https://gamewith.jp/shadowverse-wb/525586' }, processed_at: '2026-10-15T05:00:03.000Z' },
    { id: 'waiting-page', type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['expensive-page'] }, processed_at: '2026-10-15T05:00:04.000Z' });
  await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase, 'finalize-stop');
  assert.equal(h.calls.some(c => c.body?.events?.some(e => e.type === 'user.custom_tool_result')), false);
  h.setAutoAnswer(true);
  for (let i = 0; i < 8 && h.conversation.state.current; i++) await h.conversation.alarm();
  const interrupt = h.calls.findIndex(c => c.body?.events?.[0]?.type === 'user.interrupt');
  const toolResult = h.calls.findIndex(c => c.body?.events?.some(e => e.type === 'user.custom_tool_result'));
  assert.ok(interrupt >= 0 && toolResult > interrupt);
  assert.match(h.replies[0], /下版退環境的龍族卡/);
  assert.equal(h.conversation.state.blocked, undefined);
  assert.equal(budgetStatus(h.budget.state, env).accountedCents, 19);
});

test('uncertain completion submission recovers after a durable restart without another generation', async t => {
  const h=await harness(t,['可核實的完整答案。'],{loseCompletionResponse:true});
  h.localEnv.ANSWER_RESERVE_CENTS='4'; h.setAutoAnswer(false);
  await h.enqueue(input('complete-retry')); await h.conversation.alarm(); h.setUsage(14);
  h.events.push({id:'waiting',type:'session.status_idle',stop_reason:{type:'requires_action'},processed_at:'2026-10-15T05:00:03.000Z'});
  for(let i=0;i<4;i++) await h.conversation.alarm();
  assert.equal(h.conversation.state.current.phase,'complete-sending');
  const restarted=new Conversation(h.ctx,h.localEnv); await h.ctx.ready; await restarted.alarm();
  assert.equal(restarted.state.current,null); assert.deepEqual(h.replies,['可核實的完整答案。']);
  assert.equal(h.calls.filter(c=>c.path==='/v1/sessions/sesn_completion/events' && c.method==='POST').length,1);
  assert.equal(budgetStatus(h.budget.state,env).accountedCents,18);
});
