import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFunTool } from '../src/chat/fun.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
function harness(name, input, options = {}) {
  const job = { input: { id: '123', channelId: '456', guildId: '789', authorId: 'user', ...options.message }, toolResults: { tool: {} } };
  const state = options.state || {}, posts = [], renders = [], snapshots = [];
  const env = { ALLOWED_GUILD_IDS: '789', FUN_API_TOKEN: 'test', FUN: { fetch: async (url, init) => {
    renders.push(JSON.parse(init.body)); return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  } } };
  const event = { id: 'tool', name, input };
  const fetcher = async (url, init) => {
    if (new URL(url).hostname === 'cdn.discordapp.com') return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    if (url === 'https://svwbmeta.com/api/manifest') return Response.json({ files: { cards: 'cards-abc.json' } });
    if (url.includes('svwbmeta.com/data/')) return Response.json({ '12345678': { names: { 'zh-Hant': '測試龍' }, classId: 4, cost: 5, rarity: 4, imgHash: { 'zh-Hant': 'a'.repeat(32) } } });
    assert.equal(new URL(url).pathname, '/api/v10/channels/456/messages');
    posts.push(init.body instanceof FormData ? JSON.parse(init.body.get('payload_json')) : JSON.parse(init.body));
    if (options.failOnce && posts.length === 1) throw new TypeError('Connection lost');
    return Response.json({ id: 'sent' });
  };
  return { job, state, posts, renders, env, run: () => executeFunTool(env, event, job, state, async () => snapshots.push(structuredClone(job)), fetcher) };
}
test('lost Discord response retries the identical random roll and nonce; settled tool is not posted twice', async () => {
  const h = harness('roll_dice', { dice: '2d20+3' }, { failOnce: true });
  await assert.rejects(h.run(), /Connection lost/);
  assert.equal((await h.run()).status, 'ok');
  assert.deepEqual(h.posts[0], h.posts[1]);
  assert.deepEqual(h.posts[0].allowed_mentions, { parse: [], replied_user: false });
  assert.equal(h.posts[0].enforce_nonce, true);
  await h.run(); assert.equal(h.posts.length, 2);
});
test('random cards keep actual filters and post the official image', async () => {
  const h = harness('pick_random_card', { craft: 4, cost: 5, rarity: 4 });
  assert.equal((await h.run()).status, 'ok');
  assert.equal(h.posts[0].embeds[0].title, '測試龍');
  assert.match(h.posts[0].embeds[0].image.url, /^https:\/\/shadowverse-wb.com\/uploads\//);
});
test('custom card edits preserve prior user artwork and fields; other authors cannot reuse them', async () => {
  const art = { id: '222', channelId: '456', messageId: '123', url: 'https://cdn.discordapp.com/attachments/456/222/art.png', mediaType: 'image/png' };
  const h = harness('make_custom_card', { name: '測試龍', craft: 4, cost: 3, attack: 4, defense: 5, effect: '入場曲 抽1張卡片。', artwork_index: 1 }, { message: { images: [art] } });
  assert.equal((await h.run()).status, 'ok');
  assert.match(h.renders[0].artwork, /^data:image\/png;base64,/);
  assert.equal(h.posts[0].attachments[0].filename, 'custom-card.png');
  const edit = harness('make_custom_card', { reuse_previous: true, cost: 5 }, { state: h.state });
  assert.equal((await edit.run()).status, 'ok');
  assert.equal(edit.renders[0].name, '測試龍'); assert.equal(edit.renders[0].cost, 5);
  assert.equal(edit.renders[0].artwork, h.renders[0].artwork);
  const other = harness('make_custom_card', { reuse_previous: true, cost: 9 }, { state: h.state, message: { authorId: 'other' } });
  assert.equal((await other.run()).status, 'unavailable'); assert.equal(other.posts.length, 0);
});
test('invalid fields, foreign guilds, unavailable images and rejected renders cannot claim success', async () => {
  for (const [name, args, options] of [
    ['roll_dice', { dice: '99d6' }], ['pick_random_card', { craft: 8 }],
    ['make_custom_card', { name: 'test', artwork: 'https://evil.test/image.png' }],
    ['make_custom_card', { name: 'test', artwork_index: 1 }],
    ['roll_dice', {}, { message: { guildId: 'other' } }],
  ]) {
    const h = harness(name, args, options); assert.equal((await h.run()).status, 'unavailable'); assert.equal(h.posts.length, 0);
  }
  const h = harness('make_custom_card', { name: 'test' });
  h.env.FUN.fetch = async () => Response.json({ error: '文字超出範圍。' }, { status: 400 });
  const result = await h.run(); assert.equal(result.status, 'unavailable'); assert.match(result.message, /超出/); assert.equal(h.posts.length, 0);
});
