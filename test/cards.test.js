import test from 'node:test';
import assert from 'node:assert/strict';
import { cardContext, matchCards } from '../src/chat/cards.js';
import { userEvent } from '../src/chat/conversation.js';
import { executeResearchTool } from '../src/chat/research.js';

const index = {
  '10924110': { names: { 'zh-Hant': '逆行的罪人‧芭芭蘿絲', ja: '逆行の咎人・バルバロス', en: 'Barbaros, Rebellious Convict' } },
  '10914110': { names: { 'zh-Hant': '新綠的守護者‧艾莉亞' } },
  '10021110': { names: { 'zh-Hant': '瞬息的迅捷劍士', en: 'Flashstep Quickblader' } },
};
function fixture(data = index, failure = null) {
  const calls = [];
  const fetcher = async (raw, options) => {
    const url = new URL(raw); calls.push(url);
    assert.equal(options.redirect, 'manual');
    if (url.hostname === 'svwbmeta.com') {
      if (url.pathname === '/api/manifest') return Response.json({ files: { cards: failure === 'manifest' ? '../secret.json' : 'cards-123.json' } });
      assert.equal(url.pathname, '/data/cards-123.json');
      return Response.json(data);
    }
    assert.equal(url.hostname, 'shadowverse-wb.com');
    assert.equal(url.pathname, '/web/CardList/card');
    assert.equal(options.headers.lang, 'cht');
    if (failure === 'http') return new Response('', { status: 503 });
    if (failure === 'large') return new Response('x'.repeat(2 * 1024 * 1024 + 1));
    const id = url.searchParams.get('card_id');
    return Response.json({ data_headers: { result_code: 1 }, data: { card_details: {
      [id]: { common: { card_id: failure === 'wrong_id' ? 123 : Number(id), name: data[id]?.names['zh-Hant'],
        cv: '悠木碧', illustrator: 'ヘスン', cost: 7, class: 2, type: 1, atk: 4, life: 3,
        skill_text: '<color=Keyword>疾馳</color>' }, style_card_list: [{ cv: '' }] },
    } } });
  };
  return { fetcher, calls };
}

test('multilingual full names and character aliases resolve without unrelated franchise guesses', () => {
  for (const text of ['芭芭蘿絲聲優是誰', '逆行的罪人・芭芭蘿絲', 'バルバロスのCV', 'Barbaros voice actress']) {
    assert.equal(matchCards(text, index)[0]?.id, '10924110');
  }
  assert.equal(matchCards('七龍珠的芭朵絲', index).length, 0);
  assert.equal(matchCards('quick blader', index)[0]?.id, '10021110');
  assert.equal(matchCards('quick', index).length, 0);
});

test('official CV and direct source are supplied, and the catalog is cached', async () => {
  const { fetcher, calls } = fixture();
  const result = await cardContext('芭芭蘿絲的聲優？', {}, fetcher);
  assert.equal(result.status, 'ok');
  assert.equal(result.cards[0].voiceActorJapanese, '悠木碧');
  assert.equal(result.cards[0].verification, 'official');
  assert.equal(result.cards[0].text, '疾馳');
  assert.equal(result.cards[0].source, 'https://shadowverse-wb.com/cht/deck/cardslist/card/?card_id=10924110');
  assert.equal(result.cards[0].alternateStyles[0].voiceActorJapanese, null);
  await cardContext('Barbaros CV', {}, fetcher);
  assert.equal(calls.filter(u => u.hostname === 'svwbmeta.com').length, 2);
  assert.match(userEvent({ text: '誰配的', cards: result }).content[0].text, /card_lookup.*悠木碧/s);
});

test('general source reader uses the exact official card ID instead of a dynamic HTML shell', async () => {
  const { fetcher, calls } = fixture();
  const result = await executeResearchTool('read_svwb_source', { url: 'https://shadowverse-wb.com/cht/deck/cardslist/card/?card_id=10021110' }, fetcher);
  assert.equal(result.cards[0].id, '10021110');
  assert.equal(result.cards[0].name, '瞬息的迅捷劍士');
  assert.equal(result.cards[0].verification, 'official');
  assert.equal(calls.length, 1);
});

test('follow-ups use quoted or recent cards, while an explicit new name takes priority', async () => {
  const { fetcher } = fixture();
  const quote = await cardContext('你確定嗎，這是SVWB卡牌', { replyText: '芭芭蘿絲可能是芭朵絲，山口由里子' }, fetcher);
  assert.equal(quote.matchedFrom, 'quoted_message');
  assert.equal(quote.cards[0].voiceActorJapanese, '悠木碧');
  const recent = await cardContext('她的聲優呢？', { previousCardIds: ['10924110'] }, fetcher);
  assert.equal(recent.matchedFrom, 'recent_conversation');
  const changed = await cardContext('艾莉亞呢？', { previousCardIds: ['10924110'] }, fetcher);
  assert.equal(changed.cards[0].id, '10914110');
  assert.equal(await cardContext('你好', { previousCardIds: ['10924110'] }, fetcher), null);
});

test('shared aliases preserve ambiguity while a complete title disambiguates', async () => {
  const data = { ...index, '10824110': { names: { 'zh-Hant': '海賊皇后‧芭芭蘿絲' } } };
  const { fetcher } = fixture(data);
  const result = await cardContext('芭芭蘿絲', {}, fetcher);
  assert.equal(result.candidateCount, 2);
  const full = await cardContext('逆行的罪人・芭芭蘿絲', {}, fetcher);
  assert.equal(full.candidateCount, 1);
});

test('official URL bypasses catalog and missing names never assert nonexistence', async () => {
  const { fetcher, calls } = fixture();
  const result = await cardContext('https://shadowverse-wb.com/cht/deck/cardslist/card/?card_id=10924110', {}, fetcher);
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 1);
  const missing = await cardContext('未知角色的聲優', {}, fetcher);
  assert.equal(missing.status, 'not_found');
  assert.match(missing.message, /不代表卡片不存在/);
});

test('invalid manifests, oversized replies and official failures never fabricate CV evidence', async () => {
  for (const failure of ['manifest', 'http', 'large', 'wrong_id']) {
    const { fetcher, calls } = fixture(index, failure);
    const result = await cardContext('芭芭蘿絲的聲優', {}, fetcher);
    assert.equal(result.status, 'unavailable');
    assert.ok(!JSON.stringify(result).includes('悠木碧'));
    if (failure === 'manifest') assert.equal(calls.length, 1);
  }
});
