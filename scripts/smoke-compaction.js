import { readFile, writeFile } from 'node:fs/promises';
import { Conversation, readCost } from '../src/chat/conversation.js';
import { DailyBudget, budgetStatus } from '../src/chat/budget.js';
import { claude } from '../src/chat/api.js';
import { FakeContext, input } from '../test/helpers.js';
const setup = JSON.parse(await readFile('.chat-setup.json', 'utf8'));
const nativeFetch = globalThis.fetch, replies = [], sessions = [];
// Exercise the real conversation state machine and Claude API. Discord delivery
// is replaced locally, so no channel receives these test messages.
globalThis.fetch = async (raw, init = {}) => {
  const url = new URL(raw);
  if (url.hostname === 'discord.com') {
    if (url.pathname.endsWith('/messages')) replies.push(JSON.parse(init.body).content);
    return Response.json({ id: 'test-delivery' });
  }
  const response = await nativeFetch(raw, init);
  if (url.hostname === 'api.anthropic.com' && url.pathname === '/v1/sessions' && init.method === 'POST' && response.ok) {
    sessions.push((await response.clone().json()).id);
  }
  return response;
};
const env = { ...process.env, CLAUDE_AGENT_ID: setup.agentId, CLAUDE_AGENT_VERSION: String(setup.agentVersion),
  CLAUDE_ENVIRONMENT_ID: setup.environmentId, DAILY_BUDGET_CENTS: '30', TURN_BUDGET_CENTS: '8', BUDGET_MARGIN_CENTS: '1' };
const budgetCtx = new FakeContext(), budget = new DailyBudget(budgetCtx, env); await budgetCtx.ready;
env.BUDGET = { getByName: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) };
const ctx = new FakeContext(), conversation = new Conversation(ctx, env); await ctx.ready;
async function turn(id, text) {
  await conversation.fetch(new Request('https://test/message', { method: 'POST', body: JSON.stringify(input(id, {
    channelId: 'compaction-test', text, meta: null, decks: [],
  })) }));
  for (let i = 0; i < 60; i++) {
    await conversation.alarm();
    if (!conversation.state.current && !conversation.state.queue.length) return;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw Error('Timed out');
}
try {
  await turn('remember', '之後討論 SVWB 組牌時，請記住我的合成預算是 3210 乙太，只玩精靈。這是我的偏好，現在不查攻略。請用一句話確認。');
  conversation.state.contextTokens = 81000; // Force the boundary without buying 80K filler tokens.
  await conversation.save();
  await turn('recall', '我剛剛說的合成預算是多少？只玩哪個職業？請只用對話紀錄回答，不要搜尋。');
  const usage = await Promise.all(sessions.map(id => claude(env, `/sessions/${id}`).then(s => readCost(s))));
  const result = { sessions: sessions.length, replies, summary: conversation.state.summary,
    listCostCents: usage.reduce((a, b) => a + b, 0), accountedCents: budgetStatus(budget.state, env).accountedCents };
  console.log(JSON.stringify(result)); await writeFile('.wrangler/compaction-check.json', JSON.stringify(result, null, 2));
  if (sessions.length !== 2 || replies.length !== 2 || !/3,?210/.test(replies[1]) || !replies[1].includes('精靈')) throw Error('Compaction continuity failed');
} catch (e) { console.error(e.status ? `HTTP ${e.status}` : e.message); process.exitCode = 1; }
finally {
  for (const id of sessions) await claude(env, `/sessions/${id}`, 'DELETE').catch(() => console.error('Test session cleanup needs retry'));
  globalThis.fetch = nativeFetch;
}
