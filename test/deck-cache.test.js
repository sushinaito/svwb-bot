import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeckCache,simpleDeckRequest} from '../src/chat/deck-cache.js';
import {collectDeliveryDecks} from '../src/chat/pictures.js';
import {isLocalResearch,executeResearchTool} from '../src/chat/research.js';

const index={10612120:{names:{ja:'ハウリングウルフマン',cht:'嚎聲狼人',en:'Howling Wolfman'}}};
const cards={index,get:id=>({name:id==='10612120'?'嚎聲狼人':id})};
const deck={id:'fixture',classId:1,format:'rotation',deckUrl:'https://shadowverse-wb.com/cht/deck/detail/?hash=1.1'+'.abcd'.repeat(40),
 cards:[...Array.from({length:13},(_,i)=>({id:String(10612120+i),quantity:3})),{id:'999',quantity:1}],
 sources:[{site:'example',url:'https://svwbmeta.com/deck'}],lastSeenAt:'2026-10-15'};
const snapshot={schemaVersion:1,syncedAt:'2026-10-15T00:00:00Z',decks:[deck]};

test('fast request matches exact multilingual names and declines extra constraints',()=>{
 for(const name of ['ハウリングウルフマン','嚎聲狼人','Howling Wolfman']) assert.deepEqual(simpleDeckRequest(`來一套有帶${name}的妖精`,index),{card_ids:['10612120'],class_id:1,format:'rotation'});
 for(const text of ['來一套有帶狼人的妖精','來一套有帶嚎聲狼人的妖精，不要傳說','推薦一套最強的妖精','來一套有帶嚎聲狼人的便宜妖精','來一套有帶嚎聲狼人的妖精，無限制'])assert.equal(simpleDeckRequest(text,index),null);
 assert.equal(simpleDeckRequest('來一套有帶嚎聲狼人的妖精',{...index,other:index[10612120]}),null);
});

test('deck search enforces AND, class and format, retains sources and complete cards',()=>{
 const cache=createDeckCache(snapshot,cards);
 assert.equal(cache.metadata.available,true);
 const result=cache.search({query:'ハウリングウルフマン',card_ids:['999'],class_id:1});
 assert.equal(result.total,1);assert.equal(result.decks[0].cards[0].name,'嚎聲狼人');
 assert.equal(collectDeliveryDecks(result)[0].cards.reduce((sum,c)=>sum+c.quantity,0),40);
 for(const filters of [{card_ids:['10612120','888']},{class_id:2},{format:'unlimited'}])assert.equal(cache.search(filters).total,0);
 for(const filters of [{limit:11},{query:{}},{card_ids:'10612120'},{class_id:8},{format:'starter'}])assert.equal(cache.search(filters).status,'unavailable');
 assert.equal(cache.search({query:'狼人'}).status,'not_found');
});

test('invalid snapshots fail closed rather than serving incomplete or foreign decks',()=>{
 for(const bad of [{...snapshot,decks:[deck,deck]},{...snapshot,syncedAt:'invalid'},
  {...snapshot,decks:[{...deck,cards:deck.cards.slice(1)}]},
  {...snapshot,decks:[{...deck,classId:4}]},
  {...snapshot,decks:[{...deck,deckUrl:deck.deckUrl.replace('shadowverse-wb.com','evil.example')}]}])assert.equal(createDeckCache(bad,cards).metadata.available,false);
});

test('deck library is local research and never silently ignores unsupported filters',async()=>{
 assert.equal(isLocalResearch('query_svwb_data',{resource:'deck_library'}),true);
 const result=await executeResearchTool('query_svwb_data',{resource:'deck_library',filters:{cost:2}},()=>{throw Error('Must not fetch');});
 assert.equal(result.status,'unavailable');
});
