import test from 'node:test';
import assert from 'node:assert/strict';
import { metaContext } from '../src/chat/meta.js';
import { userEvent } from '../src/chat/conversation.js';

test('latest Dragon lookup uses manifest data and Chinese labels, preserving sample meaning', async () => {
  const calls = [];
  const fixtures = {
    '/api/manifest': { builtAt: '2026-10-15T06:00:00Z', files: { 'deck.rotation.14': 'deck-a.json', cards: 'cards-a.json', archetypes: 'labels-a.json', 'archdeck.rotation.abc': 'arch-a.json' } },
    '/data/deck-a.json': { window: { from: '2026-10-01', to: '2026-10-14' }, classes: [{ class: 'Dragon', total: 54, archetypes: [{ name: 'ランプD', id: 'abc', builds: 47, pct: 87 }] }] },
    '/data/labels-a.json': { 'ランプD': { 'zh-Hant': '跳費龍' } },
    '/data/cards-a.json': { '123': { names: { 'zh-Hant': '龍之啟示' }, cost: 2, skill: { 'zh-Hant': '增加<b>PP</b>' } } },
    '/data/arch-a.json': { decks: [{ postedAt: '2026-10-14 08:47', deckUrl: 'https://shadowverse-wb.com/ja/deck/detail/?hash=abc', tweetUrl: 'https://x.com/player/status/123', cards: [{ cardId: '123', count: 3 }] }] },
  };
  const result = await metaContext('可以查最新的龍族牌組嗎', async raw => {
    const url = new URL(raw); assert.equal(url.hostname, 'svwbmeta.com'); calls.push(url.pathname);
    return Response.json(fixtures[url.pathname]);
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.archetypes[0].name, '跳費龍');
  assert.equal(result.archetypes[0].decks[0].cards[0].name, '龍之啟示');
  assert.equal(result.archetypes[0].decks[0].cards[0].text, '增加PP');
  assert.equal(result.sampledClassBuilds, 54);
  assert.match(result.caveat, /不是勝率/);
  assert.equal(calls.length, 5);
  assert.match(userEvent({ text: '龍族牌組', meta: result }).content[0].text, /svwbmeta_lookup/);
});

test('unrelated requests skip lookup and manifest traversal fails closed', async () => {
  assert.equal(await metaContext('你好', () => { throw Error('Unexpected request'); }), null);
  assert.equal(await metaContext('幫我看看這副牌 y8hf', () => { throw Error('Unexpected request'); }), null);
  let calls = 0;
  const result = await metaContext('最新龍族牌組', async () => {
    calls++; return Response.json({ files: { 'deck.rotation.14': '../private.json' } });
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(calls, 1);
});
