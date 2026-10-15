import test from 'node:test';
import assert from 'node:assert/strict';
import { cardCatalog } from '../src/chat/cards.js';
import { executeResearchTool } from '../src/chat/research.js';

const fixture = (count = 1, override = {}) => ({ data_headers: { result_code: 1 }, data: {
  count, sort_card_id_list: [10444110], card_set_names: { 10000: '基本卡', 10004: '蒼空六龍' },
  card_details: { 10444110: { common: { card_id: 10444110, name: '炎之攝理‧維爾納斯', class: 4,
    card_set_id: 10004, rarity: 4, cost: 9, atk: 6, life: 6, is_token: false, is_include_rotation: true,
    skill_text: '<b>測試卡效</b>', ...override } } },
} });

test('official catalog returns exact class/pack filters, complete counts, names and provenance', async () => {
  const result = await executeResearchTool('query_svwb_data', { resource: 'catalog', filters: { class_id: 4, pack_id: 10004 }, include_effects: true }, async (raw, init) => {
    const url = new URL(raw);
    assert.equal(url.pathname, '/web/CardList/cardList');
    assert.equal(url.searchParams.get('class'), '4');
    assert.equal(url.searchParams.get('card_set'), '10004');
    assert.equal(init.headers.lang, 'cht'); assert.equal(init.redirect, 'manual');
    return Response.json(fixture());
  });
  assert.equal(result.verification, 'official'); assert.equal(result.total, 1); assert.equal(result.nextOffset, null);
  assert.equal(result.cards[0].name, '炎之攝理‧維爾納斯'); assert.equal(result.cards[0].text, '測試卡效');
  assert.equal(result.packs[1].id, 10004);
});

test('catalog pagination is explicit and rejected filters never silently become a different list', async () => {
  const result = await cardCatalog({}, 30, async raw => {
    assert.equal(new URL(raw).searchParams.get('offset'), '30'); return Response.json(fixture(33));
  }, { limit: 1 });
  assert.equal(result.nextOffset, 31); assert.equal(result.total, 33);
  for (const filters of [{ class_id: 8 }, { class_id: '4' }, { pack_id: -1 }, { url: 'https://example.com' }]) {
    await assert.rejects(() => cardCatalog(filters, 0, () => { throw Error('Must not fetch'); }), /Invalid catalog filter/);
  }
  await assert.rejects(() => cardCatalog({ class_id: 4 }, 0, async () => Response.json(fixture(1, { class: 2 }))), /honor filters/);
  await assert.rejects(() => cardCatalog({}, 0, async () => Response.json(fixture(1, { card_id: 99999999 }))), /honor filters/);
});

test('large catalog batches every official page once, with no silent omissions or duplicate pages', async () => {
  const offsets = [];
  const fetcher = async raw => {
    const offset = Number(new URL(raw).searchParams.get('offset')); offsets.push(offset);
    const data = fixture(77).data;
    data.sort_card_id_list = Array.from({ length: Math.min(30, 77 - offset) }, (_, i) => 10400000 + offset + i);
    data.card_details = Object.fromEntries(data.sort_card_id_list.map(id => [id, { common: { ...fixture().data.card_details[10444110].common, card_id: id, name: `卡片${id}` } }]));
    return Response.json({ data_headers: { result_code: 1 }, data });
  };
  const result = await cardCatalog({ pack_id: 10004 }, 0, fetcher, { limit: 120 });
  assert.deepEqual(offsets, [0,30,60]); assert.equal(result.cards.length, 77); assert.equal(result.total,77);
  assert.equal(result.nextOffset,null); assert.equal(new Set(result.cards.map(c=>c.id)).size,77);
  assert.equal(result.cards[0].text,undefined);
  const packs = await cardCatalog({},0,fetcher,{view:'packs'});
  assert.equal(packs.cards.length,0); assert.equal(packs.packs[1].name,'蒼空六龍');
  await assert.rejects(() => cardCatalog({},0,async()=>Response.json(fixture(77)),{limit:120}), /Repeated catalog/);
});
