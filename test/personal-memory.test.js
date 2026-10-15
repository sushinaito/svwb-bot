import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PersonalMemory, personalMemory, executeMemoryTool, memoryPreview } from '../src/chat/personal-memory.js';
import { Conversation, userEvent } from '../src/chat/conversation.js';
import { completionEvidence } from '../src/chat/completion.js';
import { claude } from '../src/chat/api.js';
import { FakeContext, env, input } from './helpers.js';

const sha = text => createHash('sha256').update(text).digest('hex');
function cloud() {
  const stores = new Map(), memories = new Map(), calls = [];
  let sequence = 0;
  const faults = {};
  const fetcher = async (raw, init = {}) => {
    const url = new URL(raw), path = url.pathname, body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, method: init.method, body });
    assert.equal(init.headers['anthropic-beta'], path.startsWith('/v1/memory_stores') ? 'agent-memory-2026-07-22' : 'managed-agents-2026-04-01');
    if (faults.reject) return new Response(null, { status: faults.reject });
    if (path === '/v1/memory_stores') {
      if (init.method === 'GET') return Response.json({ data: [...stores.values()], next_page: null });
      const store = { ...body, id: 'memstore_' + ++sequence, archived_at: null }; stores.set(store.id, store);
      if (faults.loseCreate) { faults.loseCreate = false; throw Error('Lost create response'); }
      return Response.json(store);
    }
    const [, , , storeId, resource, memoryId] = path.split('/');
    assert.equal(resource, 'memories'); assert.ok(stores.has(storeId));
    if (init.method === 'GET') {
      if (!memoryId) return Response.json({ data: [...memories.values()].filter(m => m.memory_store_id === storeId), next_page: null });
      const m = memories.get(memoryId); return m ? Response.json(m) : new Response(null, { status: 404 });
    }
    let m = memories.get(memoryId);
    if (m && body.precondition.content_sha256 !== m.content_sha256) return new Response(null, { status: 409 });
    if (faults.conflict) {
      faults.conflict = false;
      const profile = JSON.parse(m.content); profile.facts.concurrent = { value: '另一個寫入', updatedAt: '2026-10-16T00:00:00Z' };
      m.content = JSON.stringify(profile); m.content_sha256 = sha(m.content);
      return new Response(null, { status: 409 });
    }
    if (!m) {
      if ([...memories.values()].some(v => v.memory_store_id === storeId && v.path === body.path)) return new Response(null, { status: 409 });
      m = { id: 'mem_' + ++sequence, type: 'memory', path: body.path, memory_store_id: storeId };
    }
    Object.assign(m, { content: body.content, content_sha256: sha(body.content) }); memories.set(m.id, m);
    if (faults.loseWrite) { faults.loseWrite = false; throw Error('Lost write response'); }
    return Response.json(m);
  };
  return { stores, memories, calls, faults, fetcher };
}
function namespace(localEnv) {
  const contexts = new Map(), objects = new Map();
  return { contexts, objects, restart() { objects.clear(); }, getByName(key) { return { fetch: async (url, init) => {
    if (!contexts.has(key)) contexts.set(key, new FakeContext());
    const ctx = contexts.get(key);
    if (!objects.has(key)) { objects.set(key, new PersonalMemory(ctx, localEnv)); await ctx.ready; }
    return objects.get(key).fetch(new Request(url, init));
  } }; } };
}
function harness(t) {
  const api = cloud(), localEnv = { ...env };
  localEnv.PERSONAL_MEMORY = namespace(localEnv);
  t.mock.method(globalThis, 'fetch', api.fetcher);
  const speaker = (id, text, extra = {}) => input('msg-' + id + '-' + text, { authorId: id, text, ...extra });
  const run = (speaker, name, args, id = 'tool-' + speaker.id) => executeMemoryTool(localEnv, { id, name, input: args }, { input: speaker });
  const remember = (speaker, key, value, id) => run(speaker, 'remember_personal_fact', { key, value, source_quote: speaker.text }, id);
  return { api, localEnv, speaker, run, remember, read: speaker => personalMemory(localEnv, speaker) };
}

test('each Discord speaker reuses one cloud store across conversations, guilds and object restarts; inherited owners cannot change the target', async t => {
  const h = harness(t), a = h.speaker('111', '我最喜歡龍族'), b = h.speaker('222', '我喜歡精靈', { sharedReply: true, conversationOwnerId: '111', key: a.key });
  assert.equal((await h.remember(a, 'preferred_craft', '龍族')).status, 'ok');
  assert.equal((await h.remember(b, 'preferred_craft', '精靈')).status, 'ok');
  h.localEnv.PERSONAL_MEMORY.restart();
  const freshA = { ...a, key: '123:new-channel:111', channelId: 'new-channel' };
  assert.equal((await h.read(freshA)).facts[0].value, '龍族');
  assert.equal((await h.read(b)).facts[0].value, '精靈');
  h.localEnv.ALLOWED_GUILD_IDS = '123,456';
  assert.equal((await h.read({ ...freshA, guildId: '456' })).facts[0].value, '龍族');
  assert.equal(h.api.stores.size, 2);
  assert.deepEqual([...h.api.stores.values()].map(s => s.metadata.discord_user_id).sort(), ['111', '222']);
  assert.ok([...h.localEnv.PERSONAL_MEMORY.contexts.values()].every(ctx => !JSON.stringify([...ctx.data.values()]).includes('龍族')), 'Only mappings live in Durable Object storage');
});

test('memory tools reject model-supplied identities, unsupported provenance and non-current speakers during compaction', async t => {
  const h = harness(t), a = h.speaker('111', '我喜歡龍族');
  assert.equal((await h.run(a, 'read_personal_memory', { user_id: '222' })).status, 'unavailable');
  assert.equal((await h.run(a, 'remember_personal_fact', { key: 'preferred_craft', value: '精靈', source_quote: '我喜歡精靈' })).status, 'unavailable');
  assert.equal((await h.read({ ...a, guildId: 'other' })).status, 'unavailable');
  assert.equal((await executeMemoryTool(h.localEnv, { name: 'remember_personal_fact', input: {} }, { input: a, compacting: true })).status, 'unavailable');
  assert.equal(h.api.calls.length, 0);
  await h.read(a);
  const object = h.localEnv.PERSONAL_MEMORY.objects.get('discord-user:111');
  assert.equal((await object.fetch(new Request('https://memory/read', { method: 'POST', body: JSON.stringify({ userId: '222' }) }))).status, 403);
});

test('concurrent conversations do not lose facts; cloud preconditions preserve externally updated facts', async t => {
  const h = harness(t), a = h.speaker('111', '我喜歡龍族，而且預算只有1000');
  await Promise.all([h.remember(a, 'preferred_craft', '龍族', 'one'), h.remember(a, 'crafting_budget', '1000', 'two')]);
  h.api.faults.conflict = true;
  assert.equal((await h.remember(a, 'response_style', '簡短', 'three')).status, 'ok');
  assert.deepEqual((await h.read(a)).facts.map(f => f.key).sort(), ['concurrent', 'crafting_budget', 'preferred_craft', 'response_style']);
});

test('ambiguous cloud creation and writes reconcile after restart; retries cannot restore forgotten facts', async t => {
  const h = harness(t), a = h.speaker('111', '我喜歡龍族');
  h.api.faults.loseCreate = true;
  assert.equal((await h.read(a)).status, 'unavailable');
  h.localEnv.PERSONAL_MEMORY.restart();
  assert.equal((await h.read(a)).status, 'ok'); assert.equal(h.api.stores.size, 1);
  h.api.faults.loseWrite = true;
  assert.equal((await h.remember(a, 'preferred_craft', '龍族', 'remember-once')).status, 'unavailable');
  h.localEnv.PERSONAL_MEMORY.restart();
  assert.equal((await h.remember(a, 'preferred_craft', '龍族', 'remember-once')).duplicate, true);
  const forget = h.speaker('111', '忘記我的偏好');
  await h.run(forget, 'forget_personal_fact', { key: 'preferred_craft', source_quote: forget.text });
  assert.equal((await h.remember(a, 'preferred_craft', '龍族', 'remember-once')).duplicate, true);
  assert.deepEqual((await h.read(a)).facts, []);
});

test('failures stay unavailable, and forget-all cannot affect another user’s cloud profile', async t => {
  const h = harness(t), a = h.speaker('111', '我喜歡龍族'), b = h.speaker('222', '我喜歡精靈');
  h.api.faults.reject = 401;
  assert.equal((await h.read(a)).status, 'unavailable');
  delete h.api.faults.reject;
  await h.remember(a, 'preferred_craft', '龍族'); await h.remember(b, 'preferred_craft', '精靈');
  const forget = h.speaker('222', '忘記我的所有個人記憶', { conversationOwnerId: '111', sharedReply: true });
  assert.equal((await h.run(forget, 'forget_personal_fact', { key: '*', source_quote: forget.text })).status, 'ok');
  assert.deepEqual((await h.read(b)).facts, []);
  assert.equal((await h.read(a)).facts[0].value, '龍族');
});

test('memory endpoint headers do not leak into sessions; previews and completion keep the current speaker identity', async t => {
  const h = harness(t), a = h.speaker('222', '我喜歡精靈', { conversationOwnerId: '111', sharedReply: true });
  await h.remember(a, 'preferred_craft', '精靈');
  a.personalMemory = memoryPreview(await h.read(a));
  const text = userEvent(a).content[0].text;
  assert.match(text, /"owner_id":"222"/);
  const evidence = completionEvidence(a, []);
  assert.equal(evidence.personal_memory.owner_id, evidence.current_speaker.id);
  const seen = [];
  await claude(env, '/sessions/sesn_test', 'GET', undefined, async (_url, init) => { seen.push(init.headers['anthropic-beta']); return Response.json({}); });
  assert.deepEqual(seen, ['managed-agents-2026-04-01']);
});

test('forgetting needs an explicit current request, and previews select recently corrected facts', async t => {
  const h = harness(t), a = h.speaker('111', '我喜歡龍族');
  await h.remember(a, 'preferred_craft', '龍族');
  assert.equal((await h.run(a, 'forget_personal_fact', { key: '*', source_quote: a.text })).status, 'unavailable');
  const forgetOne = h.speaker('111', '忘記我的合成預算');
  assert.equal((await h.run(forgetOne, 'forget_personal_fact', { key: '*', source_quote: forgetOne.text })).status, 'unavailable');
  assert.equal((await h.read(a)).facts[0].value, '龍族');
  const facts = Array.from({ length: 10 }, (_, i) => ({ key: 'fact_' + i, value: String(i), updated_at: new Date(1000 * i).toISOString() }));
  facts[0].updated_at = new Date(20000).toISOString();
  const preview = memoryPreview({ status: 'ok', owner_id: '111', facts });
  assert.equal(preview.total, 10); assert.equal(preview.truncated, true); assert.equal(preview.facts.length, 8);
  assert.equal(preview.facts.at(-1).key, 'fact_0');
});

test('conversation reset and compaction retain personal memory and reload it into new managed sessions', async t => {
  const h = harness(t), a = h.speaker('111', '我喜歡龍族');
  await h.remember(a, 'preferred_craft', '龍族');
  const profiles = [], events = [], replies = [];
  let seq = 0, sessionSeq = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 16, 0, 0, ++seq)).toISOString();
  t.mock.method(globalThis, 'fetch', async (raw, init = {}) => {
    const url = new URL(raw), body = init.body ? JSON.parse(init.body) : {};
    if (url.pathname.startsWith('/v1/memory_stores')) return h.api.fetcher(raw, init);
    if (url.hostname === 'discord.com') { if (body.content) replies.push(body.content); return Response.json({ id: 'discord-' + ++seq }); }
    if (url.pathname === '/v1/sessions') return Response.json({ id: 'sesn_' + ++sessionSeq });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/events')) {
      if (init.method === 'POST') {
        const accepted = body.events.map(e => ({ ...e, id: 'event-' + ++seq, processed_at: stamp() })); events.push(...accepted);
        for (const e of accepted.filter(e => e.type === 'user.message')) {
          const text = e.content[0].text;
          if (text.includes('{"discord_message_id"')) profiles.push(JSON.parse(text.slice(text.indexOf('{"discord_message_id"'))));
          events.push({ id: 'answer-' + ++seq, type: 'agent.message', content: [{ type: 'text', text: text.includes('精簡摘要') ? '本段討論龍族；使用者111偏好龍族。' : '龍族。' }], processed_at: stamp() },
            { id: 'idle-' + ++seq, type: 'session.status_idle', stop_reason: { type: 'end_turn' }, processed_at: stamp() });
        }
        return Response.json({ data: accepted });
      }
      const since = url.searchParams.get('created_at[gte]');
      return Response.json({ data: events.filter(e => !since || e.processed_at >= since) });
    }
    return Response.json({ status: 'idle', usage: { list_cost: { currency: 'USD', amount: '1' } } });
  });
  h.localEnv.BUDGET = { getByName: () => ({ fetch: async raw => Response.json(raw.endsWith('/reserve') ? { approved: true, allowance: 20, reserved: 22 } : {}) }) };
  const ctx = new FakeContext(), c = new Conversation(ctx, h.localEnv); await ctx.ready;
  const run = async (id, extra = {}) => {
    await c.fetch(new Request('https://conversation/message', { method: 'POST', body: JSON.stringify(input(id, { authorId: '111', text: '我喜歡哪個職業？', decks: [], cards: null, meta: null, guides: null, ...extra })) }));
    for (let i = 0; i < 10 && (c.state.current || c.state.queue.length); i++) await c.alarm();
    assert.equal(c.state.current, null); assert.ok(!c.state.blocked);
  };
  await run('first'); const firstSession = c.state.sessionId;
  c.state.contextTokens = 90000;
  await run('compact'); assert.notEqual(c.state.sessionId, firstSession); assert.ok(c.state.summary);
  await run('reset', { command: 'reset' }); assert.equal(c.state.sessionId, undefined);
  await run('fresh');
  assert.equal(profiles.length, 3);
  assert.ok(profiles.every(p => p.personal_memory.owner_id === '111' && p.personal_memory.facts[0].value === '龍族'));
  assert.equal(h.api.stores.size, 1);
  assert.equal((await h.read(a)).facts[0].value, '龍族');
});
