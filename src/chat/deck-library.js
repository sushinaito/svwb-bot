import snapshot from '#deck-snapshot' with {type:'json'};
import {createDeckCache,deckCache} from './deck-cache.js';
import {boundedJson,deckRevision} from './deck-library-data.js';
import {json} from './api.js';
import {cardSignature} from './decks.js';

// One cloud database serves every conversation. Daily changes are data writes,
// not Worker deployments. The bundled snapshot only seeds an empty database.
export class DeckLibrary {
  constructor(ctx,env,seed=snapshot) {
    this.ctx=ctx;this.env=env;
    ctx.blockConcurrencyWhile(async()=>{
      const manifest=await ctx.storage.get('manifest');
      if(manifest){
        const keys=Array.from({length:manifest.parts},(_,i)=>`part:${i}`);
        const parts=await ctx.storage.get(keys);
        this.data=JSON.parse(keys.map(k=>parts.get(k)).join(''));
      }else{
        this.data=structuredClone(seed);
        if(createDeckCache(this.data).metadata.available)await this.persist(this.data);
      }
      this.cache=createDeckCache(this.data);
    });
  }

  async persist(data) {
    const text=JSON.stringify(data),entries={};
    const parts=Math.ceil(text.length/100000);
    if(parts>110)throw Error('Library too large');
    for(let i=0;i<parts;i++)entries[`part:${i}`]=text.slice(i*100000,(i+1)*100000);
    entries.manifest={parts,revision:data.revision};
    // One atomic multi-key write, with every value below SQLite's 2 MiB limit.
    await this.ctx.storage.put(entries);
  }

  metadata(){return {...this.cache.metadata,storage:'cloud_durable_object',lastCheckedAt:this.data.lastCheckedAt,
    lastCloudSyncAt:this.data.lastCloudSyncAt,scheduler:'claude_managed_agents',syncStatus:this.data.syncStatus||'seeded',sourceErrors:this.data.errors||[]};}

  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&path==='/status')return json(this.metadata());
    if(request.method==='GET'&&path==='/snapshot')return json(this.data);
    if(request.method==='POST'&&path==='/search'){
      const filters=await boundedJson(request,4096);
      return json({...this.cache.search(filters),source:'cloud:deck-library',storage:'cloud_durable_object',
        syncStatus:this.data.syncStatus||'seeded',sourceErrors:this.data.errors||[]});
    }
    if(request.method==='PUT'&&path==='/snapshot'){
      let data;
      try{data=await boundedJson(request);}catch{return json({error:'Invalid snapshot body'},400);}
      const candidate=createDeckCache(data);
      const validErrors=Array.isArray(data.errors)&&data.errors.length<=100&&data.errors.every(e=>{
        try{return typeof e.error==='string'&&e.error.length<=500&&new URL(e.source).protocol==='https:';}catch{return false;}
      });
      if(!candidate.metadata.available||!data.revision||!validErrors||data.errors.length&&data.syncStatus!=='partial'||
        !Number.isFinite(Date.parse(data.lastCheckedAt))||data.revision!==await deckRevision(data.decks))return json({error:'Invalid or incomplete snapshot'},400);
      return this.ctx.blockConcurrencyWhile(async()=>{
        if(request.headers.get('If-Match')!==this.data.revision)return json({error:'Snapshot changed; fetch it again'},409);
        const incoming=new Map(data.decks.map(d=>[d.id,d]));
        // Incremental maintenance may add builds or sources, never delete or
        // alter the quantities of a build that people already received.
        if((this.data.decks||[]).some(d=>!incoming.has(d.id)||cardSignature(incoming.get(d.id).cards)!==cardSignature(d.cards)||
          d.sources.some(s=>!incoming.get(d.id).sources.some(n=>n.site===s.site&&n.url===s.url)))||
          Date.parse(data.lastCheckedAt)<Date.parse(this.data.lastCheckedAt||this.data.syncedAt))return json({error:'Snapshot would regress'},409);
        const changed=data.revision!==this.data.revision;
        data.lastCloudSyncAt=new Date().toISOString();
        await this.persist(data);
        this.data=data;this.cache=createDeckCache(data);
        return json({status:data.errors.length?'partial':'ok',changed,...this.metadata()});
      });
    }
    return json({error:'Not found'},404);
  }
}

export async function searchDeckLibrary(env,filters) {
  if(!env?.DECK_LIBRARY)return deckCache.search(filters);
  try{
    const response=await env.DECK_LIBRARY.getByName('main').fetch('https://library/search',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(filters),
    });
    if(!response.ok)throw Error('Library unavailable');
    return await response.json();
  }catch{return {...deckCache.search(filters),storage:'bundled_fallback',cloudUnavailable:true};}
}

export async function deckLibraryStatus(env) {
  if(!env?.DECK_LIBRARY)return deckCache.metadata;
  try{
    const response=await env.DECK_LIBRARY.getByName('main').fetch('https://library/status');
    if(!response.ok)throw Error('Library unavailable');
    return await response.json();
  }catch{return {...deckCache.metadata,storage:'bundled_fallback',cloudUnavailable:true};}
}
