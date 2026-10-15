import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { claude } from '../src/chat/api.js';
import { Conversation, eventsSince, readCost } from '../src/chat/conversation.js';
import { DailyBudget } from '../src/chat/budget.js';
import { FakeContext } from '../test/helpers.js';
const secrets = JSON.parse(await readFile('.chat-secrets.json', 'utf8'));
const fun = JSON.parse(await readFile('C:/dev/svwb-fun-cards/.fun-secrets.json', 'utf8'));
const config = JSON.parse(await readFile('wrangler.chat.local.json', 'utf8'));
const realFetch = globalThis.fetch;
const env = { ...config.vars, ...secrets, FUN_API_TOKEN: fun.RENDER_API_TOKEN, DAILY_BUDGET_CENTS: '100', BUDGET_MARGIN_CENTS: '0',
  FUN: { fetch: (url, init) => realFetch(`https://svwb-fun-bot.svwb-deckhelper.workers.dev${new URL(url).pathname}`, init) } };
const budgetCtx = new FakeContext(), budget = new DailyBudget(budgetCtx, env); await budgetCtx.ready;
env.BUDGET = { getByName: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) };
const ctx = new FakeContext(), conversation = new Conversation(ctx, env); await ctx.ready;
const posts = [], sessions = new Set(), cases = process.argv.includes('--presentation') ? [
  ['幫我製作一張龍族3費4攻5血傳說 follower，卡名「星火幼龍」，效果是 Fanfare: Draw a card.。整張用官方繁中術語，立繪留空，直接製作效果圖。', 'make_custom_card'],
] : process.argv.includes('--capability') ? [
  ['你能diy卡牌嗎', null],
  ['那幫我做一張龍族3費4攻5血的傳說從者，叫「星火幼龍」，效果是「入場曲 抽1張卡片。」立繪先留空。', 'make_custom_card'],
] : [
  ['Can you roll two twenty-sided dice and add three?', 'roll_dice'],
  ['幫我隨機抽一張龍族的傳說卡', 'pick_random_card'],
  ['幫我做一張DIY卡叫「星火幼龍」，龍族3費4攻5血的傳說從者，效果是「入場曲 抽1張卡片。」不用上傳圖，直接用預設圖做成有卡片效果的圖。', 'make_custom_card'],
  ['把剛剛那張改成5費，其他不變，再做一張圖給我。', 'make_custom_card'],
];
globalThis.fetch = async (url, init) => {
  if (new URL(url).hostname === 'discord.com') {
    if (String(url).endsWith('/messages')) {
      const form = init.body instanceof FormData;
      const payload = form ? JSON.parse(init.body.get('payload_json')) : JSON.parse(init.body);
      posts.push(payload);
      if (form) await writeFile(`.wrangler/chat-card-${posts.length}.png`, Buffer.from(await init.body.get('files[0]').arrayBuffer()));
    }
    return Response.json({ id: `captured-${posts.length}` });
  }
  const response = await realFetch(url, init);
  if (new URL(url).hostname === 'api.anthropic.com' && String(url).endsWith('/sessions') && init?.method === 'POST' && response.ok)
    sessions.add((await response.clone().json()).id);
  if (!response.ok && new URL(url).hostname === 'api.anthropic.com') {
    const error = await response.clone().json().catch(() => ({}));
    console.error(JSON.stringify({ status: response.status, message: error.error?.message?.slice(0, 500) }));
  }
  return response;
};
try {
  // Upgrade an existing session: no reset or loss of previous history required.
  const old = await claude(env, '/sessions', 'POST', { agent: { type: 'agent', id: env.CLAUDE_AGENT_ID, version: Number(process.env.SMOKE_AGENT_VERSION || env.CLAUDE_AGENT_VERSION) },
    environment_id: env.CLAUDE_ENVIRONMENT_ID, title: 'SVWB natural fun smoke', budget: { type: 'limit', max_list_cost: { amount: '20', currency: 'USD' } } });
  conversation.state.sessionId = old.id;
  if (process.argv.includes('--capability')) conversation.state.lastCompletedAnswer = {
    question: '你能diy卡牌嗎', answer: '遊戲內沒有自製卡功能。實體卡或同人卡要注意 Fan Kit 條款。',
  };
  for (const [i, [text, expected]] of cases.entries()) {
    const before = posts.length;
    await conversation.fetch(new Request('https://conversation/message', { method: 'POST', body: JSON.stringify({
      id: `fun-test-${Date.now()}-${i}`, guildId: env.ALLOWED_GUILD_IDS.split(',')[0], channelId: 'local-only', authorId: 'test', authorName: '測試', text,
    }) }));
    for (let p = 0; p < 100; p++) {
      await conversation.alarm();
      if (!conversation.state.current && !conversation.state.queue.length) break;
      if (p === 99) throw Error('Timeout');
      await new Promise(r => setTimeout(r, 1500));
    }
    const events = await eventsSince(env, old.id);
    const own = events.findLastIndex(e => e.type === 'user.message');
    const calls = events.slice(own).filter(e => /tool_use$/.test(e.type));
    console.log(JSON.stringify({ case: i, expected, tools: calls.map(e => ({ name: e.name, input: e.input })), posts: posts.slice(before).map(p => ({ content: p.content, image: !!p.attachments || !!p.embeds?.[0]?.image })), blocked: conversation.state.blocked || null }));
    if (expected) assert.ok(calls.some(e => e.name === expected));
    else {
      const answer = posts.slice(before).map(p => p.content || '').join('\n');
      assert.match(answer, /可以|能幫|能做|會做|沒問題/);
      assert.doesNotMatch(answer, /Fan Kit|紅色乙太|智慧財產|條款|遊戲內沒有/);
      assert.equal(calls.length, 0, 'Capability questions must not invoke web research or create an unrequested card');
    }
    assert.equal(conversation.state.blocked, undefined);
    assert.equal(conversation.state.sessionId, old.id);
    if (expected) assert.ok(posts.slice(before).some(p => expected === 'roll_dice' ? p.content?.includes('2d20+3') : !!p.embeds?.[0]?.image));
    if (process.argv.includes('--presentation')) {
      const card = conversation.state.lastFunCard.card;
      assert.match(card.effect, /入場曲/);
      assert.doesNotMatch(card.effect, /登場|戰吼|Fanfare/i);
      assert.doesNotMatch(JSON.stringify(card), /[（(]\s*DIY\s*[)）]/i);
      assert.doesNotMatch(JSON.stringify(posts.slice(before)), /WB\s*製卡器|sva\.hypd\.asia|[（(]\s*DIY\s*[)）]/i);
    }
    if (i === 3) assert.equal(conversation.state.lastFunCard.card.cost, 5);
  }
  console.log(JSON.stringify({ passed: true, costCents: readCost(await claude(env, `/sessions/${old.id}`)), realDiscordPosts: 0 }));
} finally {
  for (const id of sessions) await claude(env, `/sessions/${id}`, 'DELETE').catch(() => console.error('Test cleanup failed'));
  globalThis.fetch = realFetch;
}
