import test from 'node:test';
import assert from 'node:assert/strict';
import { publishDeckCode, cardSignature } from '../src/chat/decks.js';
import { collectDeliveryDecks, deckPictures, sendDeckPictures } from '../src/chat/pictures.js';
import { Conversation, userEvent } from '../src/chat/conversation.js';
import { COMPLETION_SYSTEM, completionEvidence } from '../src/chat/completion.js';
import { RESPONSE_STYLE } from '../src/chat/style.js';
import { FakeContext, env, input } from './helpers.js';

const hash = '1.1' + '.abcd'.repeat(40);
const url = `https://shadowverse-wb.com/ja/deck/detail/?hash=${hash}`;
const cards = Array.from({ length: 14 }, (_, i) => ({ id: String(100 + i), quantity: i === 13 ? 1 : 3 }));
const data = { class_id: 1, battle_format: 1, deck_card_num: Object.fromEntries(cards.map(c => [c.id, c.quantity])),
  card_details: Object.fromEntries(cards.map(c => [c.id, { common: { name: '卡片' + c.id, cost: 1 } }])) };
const result = { status: 'ok', archetypes: [{ name: '節奏進化妖', className: '精靈', decks: [{ deckUrl: url, cards }] }] };
function portal({ mismatch = false, failure = false } = {}) {
  return async (raw, init) => {
    const path = new URL(raw).pathname;
    if (failure) return new Response('down', { status: 503 });
    if (path.endsWith('deckHashDetail')) return Response.json({ data, data_headers: { csrf_token: 'public-token' } }, { headers: { 'set-cookie': 'session=anonymous; Secure; HttpOnly' } });
    if (path.endsWith('/publish')) {
      assert.equal(init.headers['X-Csrf-Token'], 'public-token');
      assert.equal(init.headers.Cookie, 'session=anonymous');
      assert.deepEqual(JSON.parse(init.body), { hash });
      return Response.json({ data: { deck_code: 'abcd' } });
    }
    if (path.endsWith('/getDeck')) return Response.json({ data: { ...data, class_id: mismatch ? 2 : 1 } });
    if (path === '/web/Image/deck') {
      const bytes = new Uint8Array(1024); bytes.set([137,80,78,71,13,10,26,10]);
      return new Response(bytes, { headers: { 'content-type': 'image/png' } });
    }
    throw Error('Unexpected URL');
  };
}

test('official code is published with anonymous CSRF and checked against the same forty cards', async () => {
  assert.deepEqual(await publishDeckCode(url, cards, portal()), { status: 'ok', code: 'abcd' });
  for (const fetcher of [portal({ mismatch: true }), portal({ failure: true })])
    assert.deepEqual(await publishDeckCode(url, cards, fetcher), { status: 'unavailable' });
  const wrong = structuredClone(cards); wrong[0].id = '999';
  assert.equal((await publishDeckCode(url, wrong, portal())).status, 'unavailable');
  assert.equal(cardSignature([...cards, cards[0]]), null);
  assert.equal((await publishDeckCode(url.replace('shadowverse-wb.com', 'evil.example'), cards, portal())).status, 'unavailable');
});

test('delivery chooses only the exact linked build and retains tool-result card identity', () => {
  const deliveryDecks = collectDeliveryDecks(result);
  assert.deepEqual(deliveryDecks[0].cards, cards);
  assert.equal(deckPictures({ deliveryDecks }, '節奏進化妖可以考慮，但這次推薦另一套').length, 0);
  const selected = deckPictures({ deliveryDecks }, `[牌表](${url})`);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].label, '精靈・節奏進化妖');
  assert.match(selected[0].deckUrl, /\/cht\//);
  assert.deepEqual(completionEvidence({ text: '來一套', deliveryDecks }, []).available_deck_links,
    [{ label: '精靈・節奏進化妖', deckUrl: url }]);
});

test('one Discord reply includes the PNG, verified code and permanent hash link', async t => {
  let payload, file;
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    assert.equal(new URL(raw).hostname, 'discord.com');
    payload = JSON.parse(init.body.get('payload_json')); file = init.body.get('files[0]');
    return Response.json({ id: 'sent' });
  });
  await sendDeckPictures(env, input('m1', { deliveryDecks: collectDeliveryDecks(result) }), url, portal());
  assert.match(payload.content, /`abcd`/);
  assert.match(payload.content, /hash=1\.1/);
  assert.match(payload.content, /代碼可能失效/);
  assert.equal(file.type, 'image/png');
});

test('delivery errors remain retryable and existing conversations use the shared wording guidance', async t => {
  assert.ok(userEvent(input()).content[0].text.includes(RESPONSE_STYLE));
  assert.ok(COMPLETION_SYSTEM.includes(RESPONSE_STYLE));
  const ctx = new FakeContext(), conv = new Conversation(ctx, env); await ctx.ready;
  conv.state.sessionId = 'test';
  conv.state.current = { input: input(), answerParts: [url], baseline: 0 };
  conv.budget = async () => ({});
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    if (String(raw).includes('api.anthropic.com')) return Response.json({ status: 'idle', usage: { list_cost: { currency: 'USD', amount: '0' } } });
    if (new URL(raw).hostname === 'shadowverse-wb.com') return new Response('down', { status: 503 });
    if (String(init.body).includes('deck-pictures') || JSON.parse(init.body).attachments) return new Response('down', { status: 503 });
    return Response.json({ id: 'sent' });
  });
  await assert.rejects(conv.finish());
  assert.notEqual(conv.state.current.picturesHandled, true);
});

test('decks discovered by a research tool survive a restart before the tool result is accepted', async t => {
  const ctx = new FakeContext(), conv = new Conversation(ctx, env); await ctx.ready;
  conv.state.sessionId = 'test';
  conv.state.current = { input: input(), phase: 'poll', userProcessed: true, seenEvents: [] };
  const fixtures = {
    '/api/manifest': { files: { 'deck.rotation.14': 'summary.json', cards: 'cards.json', archetypes: 'labels.json', 'archdeck.rotation.elf': 'elf.json' } },
    '/data/summary.json': { window: { from: '2026-10-01', to: '2026-10-14' }, classes: [{ class: 'Elf', total: 1, archetypes: [{ id: 'elf', name: 'elf', builds: 1 }] }] },
    '/data/labels.json': { elf: { 'zh-Hant': '節奏進化妖' } },
    '/data/cards.json': Object.fromEntries(cards.map(c => [c.id, { names: { 'zh-Hant': '卡片' + c.id }, cost: 1 }])),
    '/data/elf.json': { decks: [{ deckUrl: url, cards: cards.map(c => ({ cardId: c.id, count: c.quantity })) }] },
  };
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    const u = new URL(raw);
    if (u.hostname === 'svwbmeta.com') return Response.json(fixtures[u.pathname]);
    if (init?.method === 'POST') throw Error('Lost result acknowledgement');
    return Response.json({ data: [{ id: 'tool1', type: 'agent.custom_tool_use', name: 'query_svwb_data',
      input: { resource: 'meta', query: '精靈牌組' }, processed_at: '2026-10-15T10:00:00Z' }] });
  });
  await assert.rejects(conv.poll());
  const restarted = new Conversation(ctx, env); await ctx.ready;
  assert.equal(restarted.state.current.input.deliveryDecks.length, 1);
  assert.deepEqual(restarted.state.current.input.deliveryDecks[0].cards, cards);
  assert.equal(restarted.state.current.toolResults.tool1.sent, false);
});
