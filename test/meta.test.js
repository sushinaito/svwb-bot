import test from 'node:test';
import assert from 'node:assert/strict';
import { metaContext } from '../src/chat/meta.js';
import { userEvent } from '../src/chat/conversation.js';
import { isStrategyQuestion, strategyResearch } from '../src/chat/strategy.js';

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

test('Cloudflare-compatible redirect handling rejects redirects without following them', async () => {
  let diagnostic;
  const result = await metaContext('最近最強的龍族牌組有啥', async (url, init) => {
    if (!['manual', 'follow'].includes(init.redirect)) throw new TypeError('Invalid redirect value');
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://other.example/' } });
  }, d => { diagnostic = d; });
  assert.equal(result.status, 'unavailable');
  assert.equal(diagnostic.message, 'Source HTTP 302');
});

function overviewFixture(change = {}) {
  const keys = ['Elf','Royal','Witch','Dragon','Nightmare','Bishop','Nemesis'];
  const groups = keys.map(key => ({ class: key, total: key === 'Royal' ? 30 : key === 'Dragon' ? 20 : 10,
    archetypes: [{ id: key, name: key, builds: key === 'Royal' ? 30 : key === 'Dragon' ? 20 : 10, pct: 100 }] }));
  const event = { slug: 'latest', name: 'BCL Weekly', org: 'BCL', format: 'rotation', startDate: '2026-10-11', endDate: '2026-10-11', playerCount: 5, deckCount: 10 };
  const fixtures = {
    '/api/manifest': { files: { 'deck.rotation.14': 'summary.json', archetypes: 'labels.json', tournaments: 'events.json', 'tierlist.rotation': 'tiers.json',
      'tournament.latest': 'event.json', ...Object.fromEntries(keys.map(k => [`archdeck.rotation.${k}`, `${k}.json`])) } },
    '/data/summary.json': { window: { from: '2026-10-01', to: '2026-10-14' }, classes: groups },
    '/data/labels.json': { Royal: { 'zh-Hant': '海賊皇家' }, Dragon: { 'zh-Hant': '跳費龍' }, Elf: { 'zh-Hant': '連擊精靈' } },
    '/data/tiers.json': { format: 'rotation', tiers: { t1: [{ archetype: 'Elf', class: 'Elf' }, { archetype: 'Dragon', class: 'Dragon' }] } },
    '/data/events.json': [{ ...event, slug: 'old', endDate: '2026-08-01' }, event, { ...event, slug: 'future', endDate: '2026-10-30' }],
    '/data/event.json': { tournament: event, archetypes: [{ name: 'Royal', class: 'Royal', count: 3, pct: 999 },
      { name: 'Elf', class: 'Elf', count: 5 }, { name: null, class: null, count: 2 }] },
    ...Object.fromEntries(keys.map(k => [`/data/${k}.json`, { decks: [{ deckUrl: `https://shadowverse-wb.com/ja/deck/detail/?hash=1.2.aaaa` }] }])),
    ...change,
  };
  const calls = [];
  return { fixtures, calls, fetcher: async raw => {
    const path = new URL(raw).pathname; calls.push(path);
    if (!(path in fixtures) || fixtures[path] === null) return new Response(null, { status: 503 });
    return Response.json(fixtures[path]);
  } };
}

test('screenshot question loads all classes and a dated tournament with distinct denominators', async () => {
  const f = overviewFixture();
  const result = await metaContext('現在比賽和排位最多人用的牌組是？', f.fetcher);
  assert.equal(result.status, 'ok'); assert.equal(result.scope, 'all_classes');
  assert.equal(result.classes.length, 7); assert.equal(result.sampledBuilds, 100);
  assert.equal(result.archetypes[0].name, '海賊皇家');
  assert.equal(result.archetypes[0].shareOfAllSampledBuildsPct, 30);
  assert.equal(result.archetypes[0].shareWithinClassPct, 100);
  assert.equal(result.tournament.status, 'ok');
  assert.equal(result.tournament.endDate, '2026-10-11');
  assert.equal(result.tournament.archetypes[0].name, '連擊精靈');
  assert.equal(result.tournament.archetypes[0].shareOfSubmittedDecksPct, 50);
  assert.equal(result.tournament.unknownArchetypeDecks, 2);
  assert.equal(result.tournament.archetypes[1].shareOfSubmittedDecksPct, 30, 'Recompute from counts, ignoring inconsistent source pct');
  assert.equal(result.rankedLadder.status, 'population_usage_unavailable');
  assert.ok(!f.calls.some(p => /cards|rankings/.test(p)), 'Do not load irrelevant large data');
  assert.match(userEvent({ text: '最多人用的牌組', meta: result }).content[0].text, /不要要求先指定職業/);
});

test('specific SCL questions never substitute another organizer or stale tournament', async () => {
  const f = overviewFixture();
  const result = await metaContext('最新 SCL 比賽最多人用的牌組', f.fetcher);
  assert.equal(result.status, 'ok'); assert.equal(result.tournament.status, 'unavailable');
  assert.ok(!f.calls.includes('/data/event.json'));
  f.fixtures['/data/events.json'] = [{ ...f.fixtures['/data/events.json'][1], endDate: '2026-09-20' }];
  const old = await metaContext('現在比賽主流牌組', f.fetcher);
  assert.equal(old.tournament.status, 'unavailable');
});

test('optional tournament and example-deck failures preserve the complete community overview', async () => {
  const f = overviewFixture({ '/data/event.json': null, '/data/Royal.json': null });
  const result = await metaContext('現在比賽和排位最多人用的牌組是？', f.fetcher);
  assert.equal(result.status, 'ok'); assert.equal(result.sampledBuilds, 100);
  assert.equal(result.tournament.status, 'unavailable'); assert.deepEqual(result.archetypes[0].decks, []);
});

test('incomplete class sets and invalid counts cannot masquerade as all-class usage', async () => {
  for (const mutate of [f => f['/data/summary.json'].classes.pop(), f => f['/data/summary.json'].classes[0].total = -1,
    f => f['/data/summary.json'].classes[0].archetypes[0].builds = 11]) {
    const fixture = overviewFixture(); mutate(fixture.fixtures);
    assert.equal((await metaContext('目前主流牌組', fixture.fetcher)).status, 'unavailable');
  }
  const f = overviewFixture(); f.fixtures['/data/event.json'].archetypes.pop();
  const result = await metaContext('比賽熱門牌組', f.fetcher);
  assert.equal(result.status, 'ok'); assert.equal(result.tournament.status, 'unavailable');
});

test('cross-class and general meta phrasing route without affecting ordinary deck analysis', async () => {
  for (const text of ['現在主流是什麼？', '推薦牌組', '最新 meta', '全職業最強牌組', '比較龍族和皇家牌組',
    '賽狗如繁螢這版本最適合玩什麼牌組', '這個版本最靠運氣的牌是哪一套牌', '現在玩啥牌', '這版適合玩什麼',
    '想玩快攻牌組', '有什麼適合新手的牌組', 'what should I play', 'best deck this patch']) {
    const f = overviewFixture();
    const result = await metaContext(text, f.fetcher);
    assert.equal(result?.scope, 'all_classes', text);
    assert.equal(result.strength.status, 'ok'); assert.equal(result.strength.tiers.t1[0].name, '連擊精靈');
  }
  assert.equal(await metaContext('幫我分析我的牌組 y8hf', () => { throw Error('Should not fetch'); }), null);
});

test('named mulligan questions load the requested archetype with bilingual cards and GameWith search terms', async () => {
  const f = overviewFixture();
  f.fixtures['/data/labels.json'].Royal = { 'zh-Hant': '海賊皇', ja: '海賊ロイヤル' };
  f.fixtures['/api/manifest'].files.cards = 'cards.json';
  f.fixtures['/data/cards.json'] = { '10921110': { names: { 'zh-Hant': '海域斥候', ja: '海域の斥候' }, cost: 2, skill: { 'zh-Hant': '召喚海賊旗' } } };
  f.fixtures['/data/Royal.json'].decks[0].cards = [{ cardId: '10921110', count: 3 }];
  const result = await metaContext('海賊皇怎麼留牌', f.fetcher);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.strategyTargets, [{ name: '海賊皇', nameJapanese: '海賊ロイヤル' }]);
  assert.equal(result.archetypes.length, 1);
  assert.equal(result.archetypes[0].decks[0].cards[0].nameJapanese, '海域の斥候');
  assert.equal(result.archetypes[0].decks[0].cards[0].quantity, 3);
  const guidance = strategyResearch('海賊皇怎麼留牌', result);
  assert.match(guidance.searchQueries[0], /^site:gamewith.jp\/shadowverse-wb\/ 海賊ロイヤル ローテーション マリガン$/);
  assert.match(userEvent({ text: '海賊皇怎麼留牌', meta: result }).content[0].text, /read_svwb_source 讀正文/);
  const followup = await metaContext('搜一下gamewith之類的攻略網', f.fetcher, undefined, '目前我讀不到海賊皇的完整牌表');
  assert.equal(followup.strategyTargets[0].name, '海賊皇');
  assert.equal(followup.archetypes[0].decks[0].cards[0].name, '海域斥候');
});

test('less popular named archetypes are not replaced by the two most popular decks', async () => {
  const f = overviewFixture();
  f.fixtures['/api/manifest'].files.cards = 'cards.json';
  f.fixtures['/data/cards.json'] = {};
  const result = await metaContext('連擊精靈的起手攻略', f.fetcher);
  assert.equal(result.status, 'ok');
  assert.equal(result.archetypes[0].name, '連擊精靈');
  assert.ok(f.calls.includes('/data/Elf.json'));
  assert.ok(!f.calls.includes('/data/Royal.json'));
  assert.ok(!f.calls.includes('/data/Dragon.json'));
  for (const text of ['海賊皇怎麼留牌', '跳費龍怎麼玩', '海賊皇對局攻略', '搜一下gamewith之類的攻略網', 'Pirate Royal mulligan']) assert.ok(isStrategyQuestion(text));
  assert.equal(strategyResearch('聲優是誰', result), null);
  const fallback = strategyResearch('這套怎麼留牌', null);
  assert.match(fallback.searchQueries[0], /gamewith/);
  assert.match(strategyResearch('無限制海賊皇打法', { format: 'unlimited' }).searchQueries[0], /アンリミテッド/);
});
