import { readFile, writeFile } from 'node:fs/promises';
import { claude, messageText } from '../src/chat/api.js';
import { Conversation, readCost, eventsSince } from '../src/chat/conversation.js';
import { DailyBudget } from '../src/chat/budget.js';
import { FakeContext } from '../test/helpers.js';

const setup = JSON.parse(await readFile('.chat-setup.json', 'utf8'));
const config = JSON.parse(await readFile('wrangler.chat.local.json', 'utf8'));
const realFetch = globalThis.fetch;
const cases = [
  { name: 'rules-existing-session', text: 'SVWB 超進化和一般進化差在哪？先手後手各從第幾回合能用？', old: true },
  { name: 'game-system', text: '剛開始玩 SVWB，想跟朋友對戰要怎麼開房間？手機和電腦能一起玩嗎？' },
  { name: 'rotation-regression', text: '下版退環境的牌' },
  { name: 'current-news', text: 'SVWB 最近一次維護是什麼時候？具體改了哪些內容？' },
  { name: 'tempo-elf-existing-session', text: '來一套節奏妖精', old: true },
];
const budgetCtx = new FakeContext();
const env = { ...process.env, ...config.vars, TURN_BUDGET_CENTS: process.env.SMOKE_TURN_CENTS || config.vars.TURN_BUDGET_CENTS,
  ANSWER_RESERVE_CENTS: '4', DAILY_BUDGET_CENTS: '100', BUDGET_MARGIN_CENTS: '0' };
const budget = new DailyBudget(budgetCtx, env); await budgetCtx.ready;
env.BUDGET = { getByName: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) };
for (const [index, item] of cases.entries()) {
  if (process.argv[2] ? !process.argv[2].split(',').map(Number).includes(index) : index > 2) continue;
  const replies = [], ctx = new FakeContext(), conversation = new Conversation(ctx, env); await ctx.ready;
  let original, finalization = false;
  globalThis.fetch = async (url, init) => {
    // All Discord operations are local captures: no test messages are posted.
    if (new URL(url).hostname === 'discord.com') {
      if (String(url).endsWith('/messages') && !(init.body instanceof FormData)) replies.push(JSON.parse(init.body).content);
      return Response.json({ id: 'local-test-reply' });
    }
    const response = await realFetch(url, init);
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
      finalization,
    };
    await writeFile(`.wrangler/research-${index}.json`, JSON.stringify({ result, events }, null, 2));
    console.log(JSON.stringify(result));
    if (result.blocked || result.reply.length < 100 || !result.reply.includes('https://') ||
      /請(?:你)?自行|建議你.{0,5}(?:打開|查看)|請提供牌組代碼|整理沒有完成/.test(result.reply) ||
      !events.some(e => e.type === 'agent.custom_tool_use' && e.name === 'read_svwb_source')) throw Error(`${item.name}: evidence or concrete answer missing`);
  } catch (error) { console.error(error.status ? `HTTP ${error.status}` : error.message); process.exitCode = 1; }
  finally {
    for (const id of [conversation.state.sessionId, original?.id, ...(conversation.state.retiredSessions || [])].filter((v,i,a)=>v&&a.indexOf(v)===i))
      await claude(env, `/sessions/${id}`, 'DELETE').catch(() => console.error('Test session cleanup failed'));
    globalThis.fetch = realFetch;
  }
}
