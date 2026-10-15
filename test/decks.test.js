import test from 'node:test';
import assert from 'node:assert/strict';
import { deckCodes, lookupDeck, normalizeDeck } from '../src/chat/decks.js';

test('natural deck-code requests and Portal links are recognized without ordinary word lookups', () => {
  assert.deepEqual(deckCodes('幫我看看這副牌：y8hf'), ['y8hf']);
  assert.deepEqual(deckCodes('check this deck code: y8hf'), ['y8hf']);
  assert.deepEqual(deckCodes('y8hf'), ['y8hf']);
  assert.deepEqual(deckCodes('https://shadowverse-wb.com/cht/deck/build_edit/?deck_code=y8hf'), ['y8hf']);
  assert.deepEqual(deckCodes('help with this deck'), []);
  assert.deepEqual(deckCodes('hello world'), []);
  assert.equal(deckCodes('牌組 abcd efgh ijkl').length, 2);
});

test('official data preserves quantities and effects, removes display markup, rejects incomplete cards', () => {
  const payload = { data: { class_id: 1, battle_format: 2, deck_card_num: { 123: 3 },
    card_details: { 123: { common: { name: '測試卡', cost: 2, skill_text: '<color=Keyword>守護</color><hr>抽牌' } } } } };
  const result = normalizeDeck(payload, 'y8hf');
  assert.equal(result.totalCards, 3);
  assert.equal(result.className, '精靈');
  assert.equal(result.cards[0].text, '守護\n抽牌');
  delete payload.data.card_details[123];
  assert.throws(() => normalizeDeck(payload, 'y8hf'));
});

test('failed and invalid Portal results are explicit unavailable data, never guessed decks', async () => {
  assert.equal((await lookupDeck('y8hf', async () => Response.json({ data: null }))).status, 'unavailable');
  assert.equal((await lookupDeck('y8hf', async () => new Response('', { status: 503 }))).status, 'unavailable');
  await assert.rejects(lookupDeck('https://example.com'), /Invalid deck code/);
});
