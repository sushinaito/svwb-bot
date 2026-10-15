import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMessage } from '../src/chat/routing.js';
import { DiscordGateway } from '../src/chat/gateway.js';
import { userEvent } from '../src/chat/conversation.js';
import { deckImageUrl, deckPictures, fetchDeckPicture, sendDeckPictures } from '../src/chat/pictures.js';
import { FakeContext, env, message, input } from './helpers.js';

const reply = (extra = {}) => message({ type: 19, content: '這套怎麼打？', mentions: [],
  message_reference: { message_id: 'bot-message', channel_id: '456', guild_id: '123' },
  referenced_message: { id: 'bot-message', channel_id: '456', author: { id: '999', bot: true }, content: '推薦跳費龍' }, ...extra });

test('direct replies without a ping include the visible quote and preserve per-user history', () => {
  const routed = routeMessage(reply(), '999', { type: 0 }, {}, env);
  assert.equal(routed.key, '123:456:789');
  assert.equal(routed.repliedToBot, true);
  assert.equal(routed.mentioned, false);
  assert.equal(routed.replyContext.text, '推薦跳費龍');
  assert.ok(userEvent(routed).content[0].text.includes('replying_to_bot_message'));
  assert.equal(routeMessage(reply({ author: { id: 'other' } }), '999', { type: 0 }, {}, env).key, '123:456:other');
  assert.equal(routeMessage(reply({ content: 'reset' }), '999', { type: 0 }, {}, env).command, 'reset');
});

test('deleted, missing, forwarded, cross-channel and other-author replies are ignored', () => {
  const base = reply();
  for (const change of [
    { referenced_message: null }, { referenced_message: undefined },
    { type: 0 }, { message_reference: { ...base.message_reference, type: 1 } },
    { message_reference: { ...base.message_reference, channel_id: 'other' } },
    { message_reference: { ...base.message_reference, guild_id: 'other' } },
    { referenced_message: { ...base.referenced_message, author: { id: 'other' } } },
    { referenced_message: { ...base.referenced_message, webhook_id: 'webhook' } },
    { referenced_message: { ...base.referenced_message, id: 'wrong' } },
  ]) assert.equal(routeMessage(reply(change), '999', { type: 0 }, {}, env), null);
});

test('gateway resolves omitted referenced messages and routes edited replies once', async t => {
  const ctx = new FakeContext(), gateway = new DiscordGateway(ctx, env);
  await ctx.ready; gateway.state.botId = '999';
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname; paths.push(path);
    if (path.endsWith('/messages/bot-message')) return Response.json(reply().referenced_message);
    if (path.endsWith('/messages/edit')) return Response.json(reply({ id: 'edit' }));
    return Response.json({ type: 0 });
  });
  await gateway.receive(reply({ referenced_message: undefined }));
  assert.equal(gateway.state.pending.length, 1);
  assert.equal(paths.filter(p => p.endsWith('/messages/bot-message')).length, 1);
  await gateway.receive(reply({ id: 'deleted', referenced_message: null }));
  assert.equal(gateway.state.pending.length, 1);
  const update = { id: 'edit', guild_id: '123', channel_id: '456', type: 19, content: 'edited', edited_timestamp: 'now' };
  await gateway.receiveEdit(update); await gateway.receiveEdit(update);
  assert.equal(gateway.state.pending.length, 2);
  assert.equal(paths.filter(p => p.endsWith('/messages/edit')).length, 1);
});

const deckUrl = 'https://shadowverse-wb.com/ja/deck/detail/?hash=1.4.fNIk.dhqm';
const picture = { deckUrl, imageUrl: deckImageUrl(deckUrl) };
const png = () => { const bytes = new Uint8Array(1024); bytes.set([137,80,78,71,13,10,26,10]); return bytes; };
const pngResponse = () => new Response(png(), { headers: { 'Content-Type': 'image/png' } });

test('picture selection is restricted to official hash decks and deduplicates', () => {
  assert.match(picture.imageUrl, /lang=cht$/);
  for (const url of ['https://evil.example/ja/deck/detail/?hash=1.4.fNIk', deckUrl.replace('https:', 'http:'), deckUrl.replace('hash=', 'deck_code='), deckUrl.replace('1.4.fNIk.dhqm', '../secret')]) assert.equal(deckImageUrl(url), null);
  const selected = deckPictures({ meta: { className: '龍族', archetypes: [{ name: '跳費龍', decks: [{ deckUrl }, { deckUrl }] }] } }, `跳費龍 [牌表](${deckUrl})`);
  assert.equal(selected.length, 1);
  assert.equal(deckPictures({}, '沒有牌表').length, 0);
});

test('image download rejects redirects, HTML, invalid PNGs and oversized bodies', async () => {
  const blob = await fetchDeckPicture(picture, async (url, options) => {
    assert.equal(url, picture.imageUrl); assert.equal(options.redirect, 'manual'); return pngResponse();
  });
  assert.equal(blob.size, 1024);
  for (const response of [new Response(null, { status: 302 }), new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response(new Uint8Array(1024), { headers: { 'Content-Type': 'image/png' } }),
    new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } })]) {
    await assert.rejects(fetchDeckPicture(picture, async () => response));
  }
});

test('deck images use Discord multipart attachments with stable nonces and no URL previews', async t => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /^https:\/\/discord.com\/api\/v10\/channels\/456\/messages$/);
    assert.ok(options.body instanceof FormData);
    assert.equal(new Headers(options.headers).has('Content-Type'), false);
    const payload = JSON.parse(options.body.get('payload_json'));
    assert.equal(payload.flags, 4);
    assert.deepEqual(payload.allowed_mentions, { parse: [], replied_user: false });
    assert.equal(payload.message_reference.message_id, 'm1');
    assert.equal(options.body.get('files[0]').type, 'image/png');
    assert.equal(payload.attachments[0].filename, 'deck-1.png');
    bodies.push(payload); return Response.json({ id: 'sent' });
  });
  await sendDeckPictures(env, input(), deckUrl, async () => pngResponse());
  await sendDeckPictures(env, input(), deckUrl, async () => pngResponse());
  assert.equal(bodies[0].nonce, bodies[1].nonce);
  await sendDeckPictures(env, input(), deckUrl, async () => new Response('unavailable', { status: 503 }));
  assert.equal(bodies.length, 2, 'Failed image download must not send an empty attachment');
});
