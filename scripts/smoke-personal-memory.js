import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { Conversation } from '../src/chat/conversation.js';
import { DiscordGateway } from '../src/chat/gateway.js';
import { DailyBudget, budgetStatus } from '../src/chat/budget.js';
import { PersonalMemory, personalMemory, executeMemoryTool } from '../src/chat/personal-memory.js';
import { claude } from '../src/chat/api.js';
import { FakeContext } from '../test/helpers.js';

// Synthetic users and intercepted Discord delivery exercise real Claude
// sessions and cloud memory stores without posting to any Discord channel.
const config = JSON.parse(await readFile('wrangler.chat.local.json', 'utf8'));
const secrets = JSON.parse(await readFile('.chat-secrets.json', 'utf8'));
const nativeFetch = globalThis.fetch, sessions = new Set(), stores = new Set(), objects = new Map(), memoryObjects = new Map(), memoryContexts = new Map(), messages = new Map(), replies = [];
const userA = `8${Date.now()}${randomInt(10000, 99999)}`, userB = String(BigInt(userA) + 1n);
const guildId = config.vars.ALLOWED_GUILD_IDS.split(',')[0], channelId = '456';
const env = { ...config.vars, ...secrets, DAILY_BUDGET_CENTS: '120', TURN_BUDGET_CENTS: '20', ANSWER_RESERVE_CENTS: '0', MAINTENANCE_BUDGET_CENTS: '0' };
const budgetCtx = new FakeContext(), budget = new DailyBudget(budgetCtx, env); await budgetCtx.ready;
env.BUDGET = { getByName: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) };
env.PERSONAL_MEMORY = { getByName: key => ({ fetch: async (url, init) => {
  if (!memoryContexts.has(key)) memoryContexts.set(key, new FakeContext());
  const ctx = memoryContexts.get(key);
  if (!memoryObjects.has(key)) { memoryObjects.set(key, new PersonalMemory(ctx, env)); await ctx.ready; }
  return memoryObjects.get(key).fetch(new Request(url, init));
} }) };
const gatewayCtx = new FakeContext(), gateway = new DiscordGateway(gatewayCtx, env); await gatewayCtx.ready;
gateway.state.botId = '999'; gateway.state.enabled = true;
env.GATEWAY = { getByName: () => ({ fetch: (url, init) => gateway.fetch(new Request(url, init)) }) };
env.CONVERSATIONS = { getByName: key => ({ fetch: async (url, init) => {
  if (!objects.has(key)) { const ctx = new FakeContext(), c = new Conversation(ctx, env); await ctx.ready; objects.set(key, c); }
  const body = JSON.parse(init.body); Object.assign(body, { decks: [], meta: null, cards: null, guides: null });
  return objects.get(key).fetch(new Request(url, { ...init, body: JSON.stringify(body) }));
} }) };
let seq = 0;
globalThis.fetch = async (raw, init = {}) => {
  const url = new URL(raw);
  if (url.hostname === 'discord.com') {
    if (url.pathname.endsWith('/typing')) return new Response(null, { status: 204 });
    if (init.method === 'POST' && url.pathname.endsWith('/messages')) {
      const body = JSON.parse(init.body), id = 'captured-' + ++seq;
      const result = { ...body, id, type: 19, channel_id: channelId, guild_id: guildId, author: { id: '999', bot: true } };
      messages.set(id, result); replies.push(result); return Response.json(result);
    }
    const id = url.pathname.match(/\/messages\/([^/]+)$/)?.[1];
    return Response.json(id ? messages.get(id) : { type: 0 });
  }
  const response = await nativeFetch(raw, init);
  if (url.hostname === 'api.anthropic.com' && init.method === 'POST' && response.ok) {
    if (url.pathname === '/v1/sessions') sessions.add((await response.clone().json()).id);
    if (url.pathname === '/v1/memory_stores') stores.add((await response.clone().json()).id);
  }
  return response;
};
async function turn(author, text, target) {
  const id = 'memory-smoke-' + ++seq;
  const message = { id, guild_id: guildId, channel_id: channelId, type: target ? 19 : 0,
    author: { id: author, username: 'MemoryTest' }, content: (target ? '' : '<@999> ') + text, mentions: target ? [] : [{ id: '999' }],
    ...(target ? { message_reference: { message_id: target.id, channel_id: channelId }, referenced_message: target } : {}) };
  messages.set(id, message);
  await gateway.receive(message);
  const key = gateway.state.pending.at(-1)?.key; assert.ok(key, 'Message must be admitted');
  await gateway.drain(); const c = objects.get(key); assert.ok(c);
  for (let i = 0; i < 100 && (c.state.current || c.state.queue.length); i++) {
    await c.alarm(); if (c.state.current) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.equal(c.state.current, null); assert.ok(!c.state.blocked, 'Conversation must finish without budget/errors');
  return { c, reply: replies.at(-1) };
}
const read = authorId => personalMemory(env, { authorId, guildId, id: 'smoke-read', text: '' });
const textOf = profile => JSON.stringify(profile.facts);
try {
  const first = await turn(userA, '請記住我的長期組牌偏好：最喜歡龍族，合成預算是3210乙太。請確實保存這兩項個人記憶，不用查牌表，簡短確認。');
  const a = await read(userA); assert.equal(a.status, 'ok'); assert.match(textOf(a), /龍族/); assert.match(textOf(a), /3210/);
  const sharedSession = first.c.state.sessionId;
  const joined = await turn(userB, '我是另一個人，請記住我自己的長期組牌偏好：最喜歡精靈，合成預算是6540乙太。請保存我這兩項個人記憶，不用查資料，簡短確認。', first.reply);
  assert.equal(joined.c, first.c); assert.equal(joined.c.state.sessionId, sharedSession);
  const b = await read(userB); assert.match(textOf(b), /精靈/); assert.match(textOf(b), /6540/);
  assert.deepEqual(await read(userA), a, 'Joining another conversation cannot overwrite its original speaker’s memory');
  memoryObjects.clear();
  const fresh = await turn(userB, '你記得我自己的職業偏好和合成預算嗎？只回答這兩項，不用查資料。');
  assert.notEqual(fresh.c, first.c); assert.match(fresh.reply.content, /精靈/); assert.match(fresh.reply.content, /6,?540/);
  const beforeCompact = fresh.c.state.sessionId; fresh.c.state.contextTokens = 90000; await fresh.c.save();
  const compacted = await turn(userB, '再說一次我自己的職業偏好和合成預算，只用個人記憶簡短回答，不用查資料。');
  assert.notEqual(compacted.c.state.sessionId, beforeCompact); assert.ok(compacted.c.state.summary);
  assert.match(compacted.reply.content, /精靈/); assert.match(compacted.reply.content, /6,?540/);
  await turn(userA, 'reset');
  const afterReset = await turn(userA, '新對話了，你記得我自己的職業偏好和合成預算嗎？只回答這兩項，不用查資料。');
  assert.match(afterReset.reply.content, /龍族/); assert.match(afterReset.reply.content, /3,?210/);
  const forgotten = await executeMemoryTool(env, { id: 'forget-smoke', name: 'forget_personal_fact', input: { key: '*', source_quote: '忘記我的所有個人記憶' } },
    { input: { authorId: userB, guildId, id: 'forget-smoke-message', text: '忘記我的所有個人記憶' } });
  assert.equal(forgotten.status, 'ok'); assert.deepEqual((await read(userB)).facts, []); assert.deepEqual(await read(userA), a);
  console.log(JSON.stringify({ passed: true, cloudStores: stores.size, speakers: 2, sharedSessionIsolated: true, freshConversationRecall: true,
    compactionRecall: true, resetRecall: true, objectRestartRecall: true, forgetIsolated: true,
    realDiscordPosts: 0, accountedCents: budgetStatus(budget.state, env).accountedCents }));
} finally {
  for (const id of sessions) await claude(env, `/sessions/${id}`, 'DELETE').catch(error => { if (error.status !== 404) throw error; });
  for (const id of stores) {
    const store = await claude(env, `/memory_stores/${id}`);
    assert.ok([userA, userB].includes(store.metadata?.discord_user_id), 'Cleanup may only delete this run’s synthetic user stores');
    await claude(env, `/memory_stores/${id}`, 'DELETE');
  }
  globalThis.fetch = nativeFetch;
}
