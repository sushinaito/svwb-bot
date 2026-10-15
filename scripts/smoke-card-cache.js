import assert from 'node:assert/strict';
import { cardCache } from '../src/chat/card-cache.js';
import { cardContext, cardCatalog } from '../src/chat/cards.js';
import { executeResearchTool } from '../src/chat/research.js';

assert.equal(cardCache.metadata.available,true,'Run with node --conditions=card-cache after cards:cache');
let requests=0;
globalThis.fetch=async()=>{ requests++; throw Error('Unexpected network request'); };
const found=new Set(); let offset=0;
do {
  const page=await cardCatalog({},offset,fetch,{limit:120,include_tokens:true});
  assert.equal(page.verification,'official_snapshot');
  for(const c of page.cards) { assert.ok(!found.has(c.id)); found.add(c.id); }
  offset=page.nextOffset;
} while(offset!==null);
assert.equal(found.size,cardCache.metadata.count);
for (const id of found) {
  const card=(await cardContext(id)).cards[0];
  assert.equal(card.id,id); assert.equal(card.verification,'official_snapshot');
}
const result=await executeResearchTool('query_svwb_data',{resource:'catalog',query:'守護',include_effects:true});
assert.ok(result.total>0); assert.ok(result.cards.every(c=>(c.name+c.text+c.evolvedText).includes('守護')));
const card=cardCache.get([...found][0]);
assert.ok((await cardContext(card.name)).cards.some(c=>c.id===card.id));
await cardContext('這張不存在的測試卡片');
assert.equal(requests,0);
let liveRequests=0;
const live=async()=>{ liveRequests++; return Response.json({data_headers:{result_code:1},data:{card_details:{[card.id]:{common:{card_id:Number(card.id),name:'更新後的官方卡名',type:4,cost:9,class:1}}}}}); };
assert.equal((await cardContext(card.id,{fresh:true},live)).cards[0].name,'更新後的官方卡名');
assert.equal(liveRequests,1,'Explicit freshness must bypass the snapshot');
console.log(JSON.stringify({passed:true,...cardCache.metadata,verifiedIds:found.size,effectMatches:result.total,networkRequests:requests}));
