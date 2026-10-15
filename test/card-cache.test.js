import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardCache } from '../src/chat/card-cache.js';
import { normalizeCachedCard } from '../scripts/cache-official-cards.js';
import { completionEvidence } from '../src/chat/completion.js';

const data = { schemaVersion: 1, complete: true, language: 'cht', fetchedAt: '2026-10-15T03:00:00Z',
  regularCount: 2, tokenCount: 1, packs: [{id:10001,name:'測試卡包'}], source: 'https://shadowverse-wb.com/web/CardList/cardList',
  cards: [
    {id:'10011111',name:'測試從者',classId:1,packId:10001,cost:2,rarity:1,isToken:false,legalInRotation:true,text:'入場曲 抽取卡片',evolvedText:'守護'},
    {id:'10011112',name:'測試法術',classId:1,packId:10001,cost:3,rarity:2,isToken:false,legalInRotation:false,text:'抽取卡片',evolvedText:''},
    {id:'90011111',name:'衍生從者',classId:1,packId:10001,cost:1,rarity:1,isToken:true,legalInRotation:false,text:'守護',evolvedText:''},
  ] };

test('snapshot searches names and both effects, preserves dates and paginates without losing cards', () => {
  const cache = createCardCache(data);
  assert.equal(cache.metadata.count,3);
  assert.equal(cache.search({class_id:1},{query:'入場曲 守護',include_effects:true}).cards[0].id,'10011111');
  assert.equal(cache.search({format:1},{query:'抽取'}).total,1);
  assert.equal(cache.search({cost:3}).cards[0].id,'10011112');
  assert.equal(cache.search({}, {query:'測試',offset:0,limit:1}).nextOffset,1);
  assert.equal(cache.search({}, {query:'測試',offset:1,limit:1}).nextOffset,null);
  assert.equal(cache.search({}, {query:'衍生',include_tokens:true}).total,1);
  assert.equal(cache.search({}, {query:'衍生'}).total,0);
  assert.equal(cache.search({}, {query:'從者',search_in:'effects'}).total,0);
  assert.equal(cache.search({}, {query:'從者',search_in:'names'}).total,1);
  assert.equal(cache.get('90011111').verification,'official_snapshot');
  assert.equal(cache.get('90011111').fetchedAt,data.fetchedAt);
  assert.equal(cache.search({}, {view:'packs'}).cards.length,0);
  assert.equal(cache.search({format:4}),null,'Do not guess eligibility for formats missing from the snapshot');
});

test('the final writer retains separate snapshot pages and actual effects with their dates', () => {
  const cache=createCardCache(data);
  const results=[cache.search({}, {offset:0,limit:1,include_effects:true}),cache.search({}, {offset:1,limit:1,include_effects:true})];
  const events=results.map((r,i)=>({id:String(i),type:'user.custom_tool_result',content:[{type:'text',text:JSON.stringify(r)}]}));
  const evidence=completionEvidence({text:'列出卡效'},events).evidence;
  assert.equal(evidence.length,2);
  assert.deepEqual(evidence.map(r=>r.cards[0].id),['10011111','10011112']);
  assert.equal(evidence[0].cards[0].text,'入場曲 抽取卡片');
  assert.equal(evidence[0].cards[0].evolvedText,'守護');
  assert.equal(evidence[0].verification,'official_snapshot');
  assert.equal(evidence[0].fetchedAt,data.fetchedAt);
});

test('partial, duplicate and mismatched snapshots cannot be used as a complete database', () => {
  for (const change of [{complete:false},{regularCount:3},{fetchedAt:'invalid'},
    {cards:[data.cards[0],data.cards[0],data.cards[2]]}]) {
    const cache=createCardCache({...data,...change});
    assert.equal(cache.metadata.available,false); assert.equal(cache.get('10011111'),null); assert.equal(cache.search(),null);
  }
});

test('official API type IDs distinguish spells from both amulet subtypes and strip markup', () => {
  for (const [type,typeName] of [[1,'從者'],[2,'護符'],[3,'護符'],[4,'法術']]) {
    const card=normalizeCachedCard('10011111',{common:{card_id:10011111,name:'測試',cost:2,class:1,type,skill_text:'<b>守護</b><hr>效果'},evo:{skill_text:'進化效果'}});
    assert.equal(card.typeName,typeName); assert.equal(card.text,'守護\n效果'); assert.equal(card.evolvedText,'進化效果');
  }
  assert.throws(()=>normalizeCachedCard('10011111',{common:{card_id:10011112}}),/Invalid official card/);
});
