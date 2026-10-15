import test from 'node:test';
import assert from 'node:assert/strict';
import { publishDeckCode, cardSignature } from '../src/chat/decks.js';
import { collectDeliveryDecks, deckPictures, sendDeckPictures, localizeDeckLinks } from '../src/chat/pictures.js';
import { Conversation, userEvent } from '../src/chat/conversation.js';
import { COMPLETION_SYSTEM, completionEvidence } from '../src/chat/completion.js';
import { RESPONSE_STYLE } from '../src/chat/style.js';
import { FakeContext, env, input } from './helpers.js';
import { executeResearchTool } from '../src/chat/research.js';

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

test('official hash source supplies the exact bilingual deck and effects before answer writing', async () => {
  let reads = 0;
  const fetcher = async (raw, init) => {
    assert.equal(new URL(raw).pathname, '/web/DeckBuilder/deckHashDetail'); reads++;
    const localized = structuredClone(data);
    for (const card of Object.values(localized.card_details)) {
      card.common.name = init.headers.lang === 'ja' ? '日本語名' : '官方繁中卡名';
      card.common.skill_text = '<b>爆能強化</b> 4';
    }
    return Response.json({ data: localized });
  };
  const actual = await executeResearchTool('read_svwb_source', { url }, fetcher);
  assert.equal(actual.status, 'ok'); assert.equal(actual.verification, 'official');
  assert.equal(actual.totalCards, 40); assert.equal(reads, 2);
  assert.equal(actual.cards[0].name, '官方繁中卡名');
  assert.equal(actual.cards[0].nameJapanese, '日本語名');
  assert.equal(actual.cards[0].text, '爆能強化 4');
  assert.equal(collectDeliveryDecks(actual)[0].cards.length, 14);
  assert.equal((await executeResearchTool('read_svwb_source', { url: url.replace(hash, '1.1.abcd') }, fetcher)).status, 'unavailable');
  assert.equal(reads, 2);
});

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

test('three recommended builds survive a missing Markdown closer before Chinese punctuation',()=>{
  const urls=[url,url.replace('1.1.','1.2.'),url.replace('1.1.','1.4.')];
  const answer=localizeDeckLinks(`[牌一](${urls[0]})\n（[牌二](${urls[1]}）\n[牌三](${urls[2]})`);
  assert.ok(!answer.includes('/ja/'));
  assert.match(answer,/\)）/);
  assert.equal(deckPictures({},answer).length,3);
});

test('guide deck links survive final-writer evidence truncation with their source identity', () => {
  const source = 'https://gamewith.jp/shadowverse-wb/507802';
  const deliveryDecks = collectDeliveryDecks({ status: 'ok', source, text: '正文'.repeat(10000),
    links: [{ title: 'Deck Portal', url }] });
  assert.deepEqual(deliveryDecks, [{ deckUrl: url, label: '牌組', source }]);
  const evidence = completionEvidence({ text: '來一套', deliveryDecks }, []);
  assert.deepEqual(evidence.available_deck_links, deliveryDecks);
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
  assert.match(payload.content, /若代碼失效/);
  assert.equal(file.type, 'image/png');
});

test('a delivered answer keeps one Chinese deck link while its attachment keeps the code and image', async t => {
  const answer = localizeDeckLinks(`試試這套：[牌表](${url})。來源：https://gamewith.jp/shadowverse-wb/123`);
  assert.equal((answer.match(/\/cht\/deck\/detail\//g) || []).length, 1);
  assert.ok(answer.includes('https://gamewith.jp/shadowverse-wb/123'));
  assert.equal(localizeDeckLinks('https://shadowverse-wb.com/ja/deck/cardslist/card/?card_id=12345678'), 'https://shadowverse-wb.com/ja/deck/cardslist/card/?card_id=12345678');
  let payload;
  t.mock.method(globalThis, 'fetch', async (raw, init) => {
    payload = JSON.parse(init.body.get('payload_json'));
    assert.equal(init.body.get('files[0]').type, 'image/png');
    return Response.json({ id: 'sent' });
  });
  await sendDeckPictures(env, input(), answer, portal(), { linksInAnswer: true });
  assert.match(payload.content, /`abcd`/);
  assert.doesNotMatch(payload.content, /^1\./);
  assert.ok(!payload.content.includes('https://'));
  assert.match(payload.content, /上方的官方牌表/);
});

test('delivery errors remain retryable and existing conversations use the shared wording guidance', async t => {
  assert.ok(userEvent(input()).content[0].text.includes(RESPONSE_STYLE));
  assert.match(COMPLETION_SYSTEM, /完整清單/);
  assert.match(COMPLETION_SYSTEM, /只回答 current_question/);
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
