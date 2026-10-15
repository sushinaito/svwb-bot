import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { routeMessage, admitMessage } from '../src/chat/routing.js';
import { jstDay, budgetStatus, reserveTurn, settleTurn, DailyBudget } from '../src/chat/budget.js';
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

async function harness(t, answers = []) {
  const budgetCtx = new FakeContext();
  const budget = new DailyBudget(budgetCtx, env);
  await budgetCtx.ready;
  const localEnv = { ...env, BUDGET: { getByName: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) } };
  const ctx = new FakeContext();
  const conversation = new Conversation(ctx, localEnv);
  await ctx.ready;
  const calls = [], replies = [], events = [];
  let sequence = 0, usage = 0, autoAnswer = true, sessionCount = 0;
  const stamp = () => `2026-10-15T05:00:${String(++sequence).padStart(2, '0')}.000Z`;
  t.mock.method(globalThis, 'fetch', async (raw, init = {}) => {
    const url = new URL(raw), body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method: init.method, body });
    if (url.hostname === 'discord.com') {
      if (url.pathname.endsWith('/messages')) replies.push(body.content);
      return Response.json({ id: `reply_${replies.length}` });
    }
    if (url.pathname === '/v1/sessions' && init.method === 'POST') {
      sessionCount++;
      if (sessionCount > 1) usage = 0;
      events.push({ id: 'initial-idle', type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: stamp() });
      return Response.json({ id: sessionCount === 1 ? 'sesn_test' : `sesn_test_${sessionCount}` });
    }
    if (url.pathname.endsWith('/events') && init.method === 'POST') {
      const event = { ...body.events[0], id: `user_${sequence}`, processed_at: stamp() };
      events.push(event);
      if (autoAnswer && event.type === 'user.message') {
        events.push({ id: `reply_${sequence}`, type: 'agent.message', processed_at: stamp(), content: [{ type: 'text', text: answers.shift() || `Answer ${sequence}` }] });
        events.push({ id: `idle_${sequence}`, type: 'session.status_idle', processed_at: stamp(), stop_reason: { type: 'end_turn' } });
        usage += 2;
      }
      return Response.json({ data: [event] });
    }
    if (url.pathname.endsWith('/events')) {
      const since = url.searchParams.get('created_at[gte]');
      return Response.json({ data: events.filter(e => !since || e.processed_at >= since), next_page: null });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    assert.ok(['GET', 'POST'].includes(init.method), 'Session updates must use POST');
    return Response.json({ id: 'sesn_test', status: 'idle', usage: { list_cost: { currency: 'USD', amount: String(usage) } } });
  });
  const enqueue = data => conversation.fetch(new Request('https://conversation/message', { method: 'POST', body: JSON.stringify(data) }));
  return { conversation, ctx, localEnv, budget, calls, replies, events, enqueue, setAutoAnswer: value => { autoAnswer = value; } };
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
  assert.deepEqual(creates[0].body.agent, { type: 'agent', id: 'agent_test', version: 1 });
  assert.equal(creates[0].body.budget.max_list_cost.amount, '20');
  assert.ok(h.calls.some(c => c.path === '/v1/sessions/sesn_test' && c.method === 'POST' && c.body.budget.max_list_cost.amount === '22'));
  assert.equal(budgetStatus(h.budget.state, env).accountedCents, 6);
  assert.equal(budgetStatus(h.budget.state, env).reservedCents, 0);
  await h.enqueue(input('m2'));
  assert.equal(h.conversation.state.queue.length, 0);
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
  assert.equal(spec.multiagent, undefined);
});
