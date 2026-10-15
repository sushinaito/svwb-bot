import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, roll } from '../src/fun/common.js';
import { cardPool } from '../src/fun/cards.js';
import { validateCard, validateArtwork } from '../src/fun/render.js';
import { makerConfig } from '../src/fun/maker.js';
import { attachmentURL, handleInteraction, verify } from '../src/fun/interactions.js';
import { createWorker } from '../src/fun/worker.js';
import { FunState } from '../src/fun/state.js';
function environment() {
  const instances = new Map();
  return { ALLOWED_GUILD_IDS: 'g', DISCORD_APPLICATION_ID: 'app', RENDER_API_TOKEN: 'secret', LEGACY_INTERACTIONS_URL: 'https://legacy.example/', STATE: { getByName(key) {
    if (!instances.has(key)) {
      const map = new Map();
      const storage = { get: async k => map.get(k), put: async (k, v) => map.set(k, v), delete: async k => map.delete(k), deleteAll: async () => map.clear(), setAlarm: async () => {}, transaction: fn => fn(storage) };
      instances.set(key, new FunState({ storage }));
    }
    return { fetch: (url, init) => instances.get(key).fetch(new Request(url, init)) };
  } } };
}
const interaction = (id, name, opts = []) => ({ id, type: 2, application_id: 'app', token: 'test', guild_id: 'g', channel_id: 'c', member: { user: { id: 'u' } }, data: { name, options: opts } });
test('dice validates bounds and applies modifiers; random selection rejects modulo bias', () => {
  assert.deepEqual(roll('2d6-3', () => 5), { expression: '2d6-3', rolls: [6, 6], modifier: -3, total: 9 });
  for (const bad of ['0d6', '51d6', '1d1', '1d100001', '2d6;exit', 'Infinity']) assert.throws(() => roll(bad));
  let calls = 0; assert.equal(randomInt(6, a => a[0] = calls++ ? 8 : 0xffffffff), 2); assert.equal(calls, 2);
});
test('card pool removes tokens, alternate identities, rotated cards and enforces exact filters', () => {
  const c = { names: { 'zh-Hant': '測試' }, classId: 4, cost: 2, rarity: 4 };
  const data = { 10000001: c, 10000002: { ...c, baseId: 10000001 }, 10000003: { ...c, isToken: true, unlimitedOnly: true }, 10000004: { ...c, unlimitedOnly: true }, 10000005: { ...c, classId: 0 } };
  assert.deepEqual(cardPool(data, { craft: 4 }).map(([id]) => id), ['10000001']);
  assert.equal(cardPool(data, { craft: 4, neutral: true }).length, 2);
  assert.equal(cardPool(data, { craft: 4, tokens: true }).length, 2);
  assert.equal(cardPool(data, { craft: 4, format: 'all' }).length, 2);
  assert.equal(cardPool(data, { cost: 3 }).length, 0);
});
test('maker maps both website layouts and all effects; validates artwork and numeric fields', () => {
  const cfg = makerConfig({ name: '<script>&', effect: '守護。'.repeat(150), evolved: '進化效果', superEvolved: '超進化效果' });
  assert.equal(cfg.name, '<script>&'); assert.equal(cfg.style, 'diy');
  assert.equal(cfg.super_evolve, '超進化效果'); assert.ok(cfg.d1_size < 32.4);
  assert.equal(makerConfig({ name: 'x', style: 'card', type: 'spell', rarity: 3 }).frame, 'spell_gold');
  assert.equal(makerConfig({ name: 'x', style: 'card' }).style, 'wb');
  assert.equal(makerConfig({ name: 'x', special: 'style_101' }).frame, 'follower_style_101');
  assert.throws(() => makerConfig({ name: 'x', effect: 'x\n'.repeat(200) }));
  assert.throws(() => validateCard({ name: 'x', craft: 8 }));
  assert.throws(() => validateCard({ name: 'x', artwork: 'https://private.example/' }));
  assert.throws(() => validateCard({ name: 'x', type: 'spell', evolved: 'test' }));
  assert.throws(() => validateCard({ name: 'x', crop: { x: 0.9, y: 0, w: 0.5, h: 1 } }));
  assert.throws(() => validateArtwork(new Uint8Array(30), 'image/png'));
  for (const url of ['http://cdn.discordapp.com/attachments/1/2/x.png', 'https://cdn.discordapp.com.evil.test/attachments/1/2/x.png', 'https://cdn.discordapp.com/private/x.png']) assert.throws(() => attachmentURL(url));
});
test('make-card modal ownership, single submission, rendering and PNG attachment', async () => {
  const env = environment(), jobs = [], sent = [];
  const ctx = { waitUntil: p => jobs.push(p) };
  const render = async c => { assert.equal(c.name, '月光之龍'); assert.equal(c.craft, 4); return new Uint8Array([137, 80, 78, 71]); };
  const fetcher = async (url, init) => { sent.push({ url, init }); return Response.json({ id: 'response' }); };
  const first = await handleInteraction(interaction('100', 'make-card', [{ name: 'craft', value: 4 }]), env, ctx, render, fetcher).then(r => r.json());
  assert.equal(first.type, 9); assert.equal(first.data.components.length, 5);
  const submit = { ...interaction('101'), type: 5, data: { custom_id: first.data.custom_id, components: [{ components: [{ custom_id: 'name', value: '月光之龍' }] }] } };
  const wrong = { ...submit, id: '102', member: { user: { id: 'other' } } };
  assert.equal((await handleInteraction(wrong, env, ctx, render, fetcher).then(r => r.json())).data.flags, 64);
  assert.equal((await handleInteraction(submit, env, ctx, render, fetcher).then(r => r.json())).type, 5);
  await Promise.all(jobs); assert.equal(sent.length, 1);
  assert.equal(sent[0].init.method, 'PATCH');
  assert.equal(sent[0].init.body.get('files[0]').type, 'image/png');
  const payload = JSON.parse(sent[0].init.body.get('payload_json'));
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  await handleInteraction(submit, env, ctx, render, fetcher); assert.equal(sent.length, 1);
});
test('random-card reports source failure after deferring; foreign guild is rejected', async () => {
  const env = environment(), jobs = [], sent = [];
  const i = interaction('103', 'random-card');
  const fetcher = async (url, init) => { if (url.startsWith('https://svwbmeta')) throw Error('source unavailable'); sent.push(JSON.parse(init.body)); return Response.json({}); };
  assert.equal((await handleInteraction(i, env, { waitUntil: p => jobs.push(p) }, null, fetcher).then(r => r.json())).type, 5);
  await Promise.all(jobs); assert.match(sent[0].content, /source unavailable/);
  const rejected = await handleInteraction({ ...i, guild_id: 'wrong' }, env, {}, null, fetcher).then(r => r.json());
  assert.equal(rejected.data.flags, 64);
});
test('API authenticates before rendering and verifies signed interactions, legacy forwarding and replay age', async () => {
  const env = environment(); let renders = 0, forwarded;
  const worker = createWorker(async () => { renders++; return new Uint8Array([137, 80, 78, 71]); }, async (url, init) => { forwarded = { url, init }; return Response.json({ type: 4, data: { content: 'legacy' } }); });
  const req = token => new Request('https://new.example/v1/cards/render', { method: 'POST', headers: { authorization: token }, body: JSON.stringify({ name: '測試' }) });
  assert.equal((await worker.fetch(req('bad'), env, {})).status, 401); assert.equal(renders, 0);
  assert.equal((await worker.fetch(req('Bearer secret'), env, {})).headers.get('content-type'), 'image/png'); assert.equal(renders, 1);
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const hex = bytes => Buffer.from(bytes).toString('hex');
  env.DISCORD_PUBLIC_KEY = hex(await crypto.subtle.exportKey('raw', keys.publicKey));
  const raw = JSON.stringify(interaction('104', 'deck')), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = hex(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + raw)));
  const signed = () => new Request('https://new.example/interactions', { method: 'POST', body: raw, headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp } });
  assert.equal(await verify(signed(), raw, env.DISCORD_PUBLIC_KEY), true);
  assert.equal(await verify(signed(), raw + ' ', env.DISCORD_PUBLIC_KEY), false);
  assert.equal(await verify(signed(), raw, env.DISCORD_PUBLIC_KEY, Date.now() + 600000), false);
  assert.equal((await worker.fetch(signed(), env, {}).then(r => r.json())).data.content, 'legacy');
  assert.equal(forwarded.init.body, raw); assert.equal(forwarded.url, env.LEGACY_INTERACTIONS_URL);
  assert.equal(forwarded.init.headers['X-Signature-Ed25519'], signature);
});
