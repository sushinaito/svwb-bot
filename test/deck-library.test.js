import test from 'node:test';
import assert from 'node:assert/strict';
import {DeckLibrary,searchDeckLibrary} from '../src/chat/deck-library.js';
import {deckRevision} from '../src/chat/deck-library-data.js';
import {cardSignature} from '../src/chat/decks.js';
import worker from '../src/chat/worker.js';
import {budgetStatus} from '../src/chat/budget.js';

const cards=[...Array.from({length:13},(_,i)=>({id:String(1000+i),quantity:3})),{id:'999',quantity:1}];
const deck={id:'first',classId:1,format:'rotation',deckUrl:'https://shadowverse-wb.com/cht/deck/detail/?hash=1.1'+'.abcd'.repeat(40),
 cards,signature:'rotation:'+cardSignature(cards),sources:[{site:'example',url:'https://svwbmeta.com/deck'}]};
async function fixture(){
 const seed={schemaVersion:1,syncedAt:'2026-10-15T00:00:00Z',lastCheckedAt:'2026-10-15T00:00:00Z',decks:[deck],resources:{},errors:[],revision:await deckRevision([deck])};
 const values=new Map();let rejectWrite=false;
 const ctx={storage:{
  get:async keys=>Array.isArray(keys)?new Map(keys.map(k=>[k,structuredClone(values.get(k))])):structuredClone(values.get(keys)),
  put:async entries=>{if(rejectWrite)throw Error('Disk failed');for(const [k,v]of Object.entries(entries))values.set(k,structuredClone(v));},
 },blockConcurrencyWhile(fn){const p=fn();this.ready=p;return p;}};
 const library=new DeckLibrary(ctx,{},seed);await ctx.ready;
 return {seed,values,ctx,library,failWrite:()=>{rejectWrite=true;}};
}
const put=(data,revision)=>new Request('https://library/snapshot',{method:'PUT',headers:{'If-Match':revision},body:JSON.stringify(data)});

test('cloud updates become queryable immediately and survive restarts without a deployment',async()=>{
 const h=await fixture(),next={...h.seed,lastCheckedAt:'2026-10-16T00:00:00Z',decks:[deck,{...deck,id:'second',classId:2,deckUrl:deck.deckUrl.replace('hash=1.1','hash=1.2')}]};
 next.revision=await deckRevision(next.decks);
 const response=await h.library.fetch(put(next,h.seed.revision));assert.equal(response.status,200);assert.equal((await response.json()).changed,true);
 const env={DECK_LIBRARY:{getByName:()=>({fetch:(url,init)=>h.library.fetch(new Request(url,init))})}};
 const result=await searchDeckLibrary(env,{card_ids:['1000'],class_id:2});assert.equal(result.total,1);assert.equal(result.storage,'cloud_durable_object');
 const restarted=new DeckLibrary(h.ctx,{});await h.ctx.ready;
 const status=await restarted.fetch(new Request('https://library/status')).then(r=>r.json());
 assert.equal(status.count,2);assert.equal(status.revision,next.revision);assert.ok(status.lastCloudSyncAt);
});

test('failed, invalid, stale or deleting syncs leave the previously served database intact',async()=>{
 const h=await fixture();
 for(const [data,revision,expected]of [
  [{...h.seed,errors:[{error:'network'}]},h.seed.revision,400],
  [{...h.seed,revision:'bad'},h.seed.revision,400],
  [h.seed,'old-revision',409],
  [{...h.seed,lastCheckedAt:'2026-10-14T00:00:00Z'},h.seed.revision,409],
 ])assert.equal((await h.library.fetch(put(data,revision))).status,expected);
 const replacement={...h.seed,decks:[{...deck,id:'replacement'}]};replacement.revision=await deckRevision(replacement.decks);
 assert.equal((await h.library.fetch(put(replacement,h.seed.revision))).status,409);
 h.failWrite();await assert.rejects(h.library.fetch(put(h.seed,h.seed.revision)),/Disk failed/);
 assert.equal(h.library.metadata().revision,h.seed.revision);assert.equal(h.library.metadata().lastCloudSyncAt,undefined);
});

test('maintenance credential is scoped to database read/write, not admin operations',async()=>{
 const env={DECK_SYNC_TOKEN:'scoped',CHAT_ADMIN_TOKEN:'admin',DECK_LIBRARY:{getByName:()=>({fetch:()=>Response.json({ok:true})})}};
 for(const key of [undefined,'wrong','admin'])assert.equal((await worker.fetch(new Request('https://bot/internal/deck-library',{headers:key?{'X-SVWB-Deck-Sync':key}:{}}),env)).status,401);
 assert.equal((await worker.fetch(new Request('https://bot/internal/deck-library',{headers:{'X-SVWB-Deck-Sync':'scoped'}}),env)).status,200);
 assert.equal((await worker.fetch(new Request('https://bot/admin/start',{method:'POST',headers:{Authorization:'Bearer scoped'}}),env)).status,401);
 assert.equal((await worker.fetch(new Request('https://bot/internal/deck-library',{method:'DELETE',headers:{'X-SVWB-Deck-Sync':'scoped'}}),env)).status,405);
});

test('a partial source outage preserves existing builds and exposes errors while accepting valid additions',async()=>{
 const h=await fixture(),data={...h.seed,lastCheckedAt:'2026-10-16T00:00:00Z',syncStatus:'partial',
  errors:[{source:'https://gamewith.jp/shadowverse-wb/497197',error:'HTTP 403'}],
  decks:[deck,{...deck,id:'new'}]};
 data.revision=await deckRevision(data.decks);
 const response=await h.library.fetch(put(data,h.seed.revision));assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.status,'partial');assert.equal(result.count,2);
 assert.deepEqual(result.sourceErrors,data.errors);
});

test('native scheduled maintenance remains inside the existing daily allowance',()=>{
 const status=budgetStatus({turns:{},days:{}},{DAILY_BUDGET_CENTS:'200',BUDGET_MARGIN_CENTS:'10',MAINTENANCE_BUDGET_CENTS:'5'});
 assert.equal(status.maintenanceCents,5);assert.equal(status.reservedCents,5);assert.equal(status.remainingCents,185);
});
