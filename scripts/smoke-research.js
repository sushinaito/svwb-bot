import { readFile, writeFile } from 'node:fs/promises';
import { claude, messageText } from '../src/chat/api.js';
import { Conversation, readCost, eventsSince } from '../src/chat/conversation.js';
import { DailyBudget } from '../src/chat/budget.js';
import { FakeContext } from '../test/helpers.js';
import { needsChineseRewrite } from '../src/chat/language.js';

const setup = JSON.parse(await readFile('.chat-setup.json', 'utf8'));
const config = JSON.parse(await readFile('wrangler.chat.local.json', 'utf8'));
const realFetch = globalThis.fetch;
const cases = [
  { name: 'rules-existing-session', text: 'SVWB 超進化和一般進化差在哪？先手後手各從第幾回合能用？', old: true },
  { name: 'game-system', text: '剛開始玩 SVWB，想跟朋友對戰要怎麼開房間？手機和電腦能一起玩嗎？' },
  { name: 'rotation-regression', text: '下版退環境的牌' },
  { name: 'current-news', text: 'SVWB 最近一次維護是什麼時候？具體改了哪些內容？' },
  { name: 'tempo-elf-existing-session', text: '來一套節奏妖', old: true, deckDelivery: true },
  { name: 'dragon-rotation-budget-regression', text: '下版本龍族退掉什麼牌', replay: true },
  { name: 'complete-rotation-list', text: '下版本全部退環境的牌，全部職業與中立都列出，不要只給重點', completeList: true },
];
const budgetCtx = new FakeContext();
const env = { ...process.env, ...config.vars, TURN_BUDGET_CENTS: process.env.SMOKE_TURN_CENTS || config.vars.TURN_BUDGET_CENTS,
  ANSWER_RESERVE_CENTS: '4', DAILY_BUDGET_CENTS: '100', BUDGET_MARGIN_CENTS: '0' };
const budget = new DailyBudget(budgetCtx, env); await budgetCtx.ready;
env.BUDGET = { getByName: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) };
for (const [index, item] of cases.entries()) {
  if (process.argv[2] ? !process.argv[2].split(',').map(Number).includes(index) : index > 2) continue;
  const replies = [], attachments = [], ctx = new FakeContext(), conversation = new Conversation(ctx, env); await ctx.ready;
  let original, finalization = false, completionEvents = [], completionCost = 0;
  const createdSessions = new Set();
  let replay;
  if (item.replay) {
    const captured = JSON.parse(await readFile('.wrangler/dragon-rotation-failure.json', 'utf8'));
    const user = captured.events.find(e => e.type === 'user.message');
    const text = user.content.find(b => b.type === 'text').text;
    replay = { data: JSON.parse(text.slice(text.indexOf('\n{"discord_message_id"') + 1)), images: user.content.filter(b => b.type === 'image') };
    conversation.state.summary = replay.data.previous_conversation_summary;
  }
  globalThis.fetch = async (url, init) => {
    // All Discord operations are local captures: no test messages are posted.
    if (new URL(url).hostname === 'discord.com') {
      if (String(url).endsWith('/messages')) {
        if (init.body instanceof FormData) {
          const payload = JSON.parse(init.body.get('payload_json'));
          replies.push(payload.content);
          for (const a of payload.attachments || []) {
            const file = init.body.get(`files[${a.id}]`);
            attachments.push({ ...a, size: file.size, type: file.type });
            await writeFile(`.wrangler/research-${index}-${a.filename}`, new Uint8Array(await file.arrayBuffer()));
          }
        } else replies.push(JSON.parse(init.body).content);
      }
      return Response.json({ id: 'local-test-reply' });
    }
    if (new URL(url).hostname === 'api.anthropic.com' && init?.method === 'DELETE' && conversation.state.current?.completionSessionId === new URL(url).pathname.split('/').at(-1)) {
      const id = conversation.state.current.completionSessionId;
      completionEvents = await eventsSince(env,id);
      completionCost = readCost(await claude(env,`/sessions/${id}`));
    }
    if (replay && new URL(url).hostname === 'api.anthropic.com' && String(url).endsWith('/events') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      const event = body.events.find(e => e.type === 'user.message' && e.content?.some(b => b.text?.includes('discord_message_id')));
      if (event) { event.content.push(...replay.images); init = { ...init, body: JSON.stringify(body) }; }
    }
    const response = await realFetch(url, init);
    if (response.ok && new URL(url).hostname === 'api.anthropic.com' && new URL(url).pathname === '/v1/sessions' && init?.method === 'POST') createdSessions.add((await response.clone().json()).id);
    if (response.ok && init?.method === 'DELETE') createdSessions.delete(new URL(url).pathname.split('/').at(-1));
    if (!response.ok && new URL(url).hostname === 'api.anthropic.com') {
      const error = await response.clone().json().catch(() => ({}));
      console.error(JSON.stringify({ status: response.status, type: error.error?.type, message: error.error?.message?.slice(0,800) }));
    }
    return response;
  };
  try {
    if (item.old) {
      original = await claude(env, '/sessions', 'POST', {
        agent: { type: 'agent', id: setup.agentId, version: setup.agentVersion - 1 }, environment_id: setup.environmentId,
        title: 'SVWB existing-session research test', budget: { type: 'limit', max_list_cost: { amount: '2', currency: 'USD' } },
      });
      conversation.state.sessionId = original.id;
      conversation.state.contextTokens = 0;
    }
    await conversation.fetch(new Request('https://conversation/message', { method: 'POST', body: JSON.stringify({
      id: `research-${index}-${Date.now()}`, authorId: 'test', authorName: '測試', channelId: 'local-only', text: item.text,
    }) }));
    for (let poll = 0; poll < 120; poll++) {
      await conversation.alarm();
      finalization ||= !!conversation.state.current?.finalizationAttempted;
      if (!conversation.state.current && !conversation.state.queue.length) break;
      if (poll === 119) throw Error('Timed out');
      await new Promise(r => setTimeout(r, 2000));
    }
    const id = conversation.state.sessionId;
    const session = await claude(env, `/sessions/${id}`), events = await eventsSince(env, id);
    const result = { case: item.name, version: session.agent.version, reply: replies.join('\n'), costCents: readCost(session),
      sessionPreserved: !original || original.id === id, blocked: conversation.state.blocked || null,
      tools: events.filter(e => /tool_use$/.test(e.type)).map(e => ({ type: e.type, name: e.name, input: e.input })),
      finalization, completionCost, totalCostCents: readCost(session) + completionCost, chunks: replies.length, attachments,
    };
    await writeFile(`.wrangler/research-${index}.json`, JSON.stringify({ result, events, completionEvents }, null, 2));
    console.log(JSON.stringify(result));
    if (item.deckDelivery && (!attachments.some(a => a.type === 'image/png' && a.size > 1024) ||
      !/牌組代碼：`[a-z0-9]{4}`/i.test(result.reply))) throw Error('Verified deck code or PNG attachment missing');
    if (item.completeList) {
      const { cardCatalog } = await import('../src/chat/cards.js');
      const expected = await cardCatalog({pack_id:10004},0,realFetch,{limit:120});
      const missing = expected.cards.filter(c=>!result.reply.includes(c.name));
      console.log(JSON.stringify({ officialTotal:expected.total, expectedNames:expected.cards.length, missing:missing.map(c=>c.name) }));
      if (expected.nextOffset !== null || missing.length) throw Error('Complete list omitted official card names');
    }
    if (item.replay && (!/蒼空六龍/.test(result.reply) || !/維爾納斯/.test(result.reply) || !/佐伊/.test(result.reply) ||
      !events.some(e => e.type === 'agent.custom_tool_use' && e.name === 'query_svwb_data' && e.input?.resource === 'catalog'))) throw Error('Rotation answer did not identify the relevant official card list');
    if (result.blocked || result.reply.length < 100 || !result.reply.includes('https://') || needsChineseRewrite(result.reply, item.text) ||
      /請(?:你)?自行|建議你.{0,5}(?:打開|查看)|請提供牌組代碼|整理沒有完成/.test(result.reply) ||
      !events.some(e => e.type === 'agent.custom_tool_use' && e.name === 'read_svwb_source')) throw Error(`${item.name}: evidence or concrete answer missing`);
  } catch (error) { console.error(error.status ? `HTTP ${error.status}` : error.message); process.exitCode = 1; }
  finally {
    for (const id of [conversation.state.sessionId, original?.id, ...createdSessions, ...(conversation.state.retiredSessions || [])].filter((v,i,a)=>v&&a.indexOf(v)===i))
      await claude(env, `/sessions/${id}`, 'DELETE').catch(() => console.error('Test session cleanup failed'));
    globalThis.fetch = realFetch;
  }
}
