import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readJson} from '../src/chat/meta.js';
import {lookupDeckHash,cardSignature} from '../src/chat/decks.js';
import {stripActive,textOf} from '../src/chat/guides.js';
import {deckRevisionContent} from '../src/chat/deck-library-data.js';

const path='data/deck-library.json';
await mkdir('data',{recursive:true});
let db={schemaVersion:1,createdAt:new Date().toISOString(),decks:[],resources:{},coverage:{}};
try{db=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const before=db.decks.length, previousRevision=db.revision, now=new Date().toISOString(), hash=s=>createHash('sha256').update(s).digest('hex');
const bySignature=new Map(db.decks.map(d=>[d.signature,d]));
const sleep=()=>new Promise(r=>setTimeout(r,500));
const errors=[];let requests=0,unchanged=0;
function add(raw,source){
 const cards=(raw.cards||[]).map(c=>({id:String(c.id??c.cardId),quantity:c.quantity??c.count}));
 const signature=cardSignature(cards);if(!signature)return false;
 const u=new URL(raw.deckUrl);const deckHash=u.searchParams.get('hash');
 if(u.hostname!=='shadowverse-wb.com'||!/^1\.[0-7](?:\.[A-Za-z0-9_-]{4,8}){40}$|^[23]\.[0-7](?:\.[A-Za-z0-9_-]{4,8}){40}$/.test(deckHash||''))return false;
 u.pathname='/cht/deck/detail/';
 const key=`${raw.format||deckHash.split('.')[0]}:${signature}`;
 let d=bySignature.get(key);
 if(!d){d={id:hash(key).slice(0,24),signature:key,deckUrl:u.href,classId:Number(deckHash.split('.')[1]),format:raw.format||({1:'rotation',2:'unlimited',3:'infinity'}[deckHash[0]]),cards,sources:[],firstSeenAt:now};bySignature.set(key,d);}
 d.lastSeenAt=now;
 if(raw.archetype)d.archetype=raw.archetype;
 const prior=d.sources.find(s=>s.url===source.url&&s.site===source.site);
 if(prior)Object.assign(prior,source,{checkedAt:now});else d.sources.push({...source,checkedAt:now});
 return true;
}
async function get(url,{immutable=false,json=false}={}){
 const old=db.resources[url];
 if(immutable&&old?.complete){unchanged++;return null;}
 const headers={};if(old?.etag)headers['If-None-Match']=old.etag;if(old?.lastModified)headers['If-Modified-Since']=old.lastModified;
 requests++;await sleep();
 const r=await fetch(url,{headers,redirect:'manual',signal:AbortSignal.timeout(20000)});
 if(r.status===304){old.checkedAt=now;unchanged++;return null;}
 if(!r.ok)throw Error(`HTTP ${r.status}`);
 const reader=r.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)throw Error('Source too large');chunks.push(value);}}
 catch(e){await reader.cancel();throw e;}finally{reader.releaseLock();}
 const text=Buffer.concat(chunks).toString('utf8');
 const digest=hash(text);
 if(old?.complete&&old.digest===digest){old.checkedAt=now;unchanged++;return null;}
 const resource={digest,etag:r.headers.get('etag'),lastModified:r.headers.get('last-modified'),checkedAt:now,complete:false};
 db.resources[url]=resource;
 return {value:json?JSON.parse(text):text,resource};
}
async function persist(){db.decks=[...bySignature.values()];db.lastCheckedAt=now;db.errors=errors;await writeFile(path+'.tmp',JSON.stringify(db));await rename(path+'.tmp',path);}
const manifest=await readJson('/api/manifest',fetch);requests++;
const labelsFile=manifest.files.archetypes;
const labels=await readJson('/data/'+labelsFile,fetch);requests++;
const metaFiles=Object.entries(manifest.files).filter(([k,v])=>/^archdeck\.(rotation|unlimited)\./.test(k)&&/^[\w.-]+\.json$/.test(v));
for(const [key,file] of metaFiles){
 const url='https://svwbmeta.com/data/'+file;
 try{
  const r=await get(url,{immutable:true,json:true});if(!r)continue;
  const data=r.value;if(!Array.isArray(data.decks))throw Error('Missing decks');let accepted=0;
  for(const d of data.decks)if(add({...d,archetype:labels[d.archetype]?.['zh-Hant']||d.archetype},{site:'SVWB Meta',url:d.tweetUrl||'https://svwbmeta.com/deck',dataset:url,postedAt:d.postedAt||null,sourceTimezone:'not specified'}))accepted++;
  Object.assign(r.resource,{complete:true,accepted,total:data.decks.length});
  console.log(JSON.stringify({source:'SVWB Meta',file,accepted,total:data.decks.length,uniqueDecks:bySignature.size}));
 }catch(e){errors.push({source:url,error:e.message});}
 await persist();
}
db.coverage.meta={manifestBuiltAt:manifest.builtAt,archetypeFiles:metaFiles.length,scope:'All complete 40-card lists in currently published rotation/unlimited archetype files; not the entire historical site.'};
await persist();
if(!process.argv.includes('--meta-only')){
 const seeds=[['GameWith','https://gamewith.jp/shadowverse-wb/497197'],['Game8','https://game8.jp/shadowverse-beyond/694512'],['Shadowverse Wins','https://shadowverse-wins.com/']];
 const archetypes=Object.values(labels).map(l=>l.ja).filter(Boolean);
 const links=html=>[...stripActive(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>({url:m[1].replace(/&amp;/g,'&'),title:textOf(m[2])}));
 for(const [site,seed] of seeds){
  let pages=[];
  try{
   // Re-discover index pages daily: old guide pages may have changed even when
   // the index returns 304, so retain their prior discovered URL list.
   const result=await get(seed);
   if(result){
    pages=[...new Set(links(result.value).filter(l=>site==='Shadowverse Wins'?/single\.php\?manageId=\d+/.test(l.url):
      archetypes.some(a=>l.title.includes(a))||/デッキ/.test(l.title)&&!/(ランキング|Tier|最強|一覧|無課金|初心者|配布|掲示板)/.test(l.title))
      .map(l=>{try{const u=new URL(l.url,seed);u.hash='';return u.hostname===new URL(seed).hostname?u.href:null}catch{return null}}).filter(Boolean))].slice(0,40);
    Object.assign(result.resource,{complete:true,pages});
   }else pages=db.resources[seed]?.pages||[];
   let resolved=0,imageOnly=0;
   for(const page of pages){
    if(site==='Shadowverse Wins'&&db.resources[page]?.complete){unchanged++;continue;}
    try{
     const r=await get(page);if(!r)continue;
     const found=[...new Set(links(r.value).map(l=>l.url).filter(u=>/^https:\/\/shadowverse-wb\.com\/(?:ja|cht|en)\/deck\/(?:detail|build_edit)\/\?hash=/.test(u)))];
     let accepted=0;
     for(const deckUrl of found.slice(0,8)){
      const known=[...bySignature.values()].find(d=>new URL(d.deckUrl).searchParams.get('hash')===new URL(deckUrl).searchParams.get('hash'));
      const deck=known||await lookupDeckHash(deckUrl);if(!known){requests+=2;await sleep();}
      if(deck.status==='unavailable')continue;
      if(add({...deck,deckUrl,format:known?.format||'rotation'},{site,url:page,title:textOf(r.value.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'').slice(0,200)})){accepted++;resolved++;}
     }
     if(!accepted)imageOnly++;
     Object.assign(r.resource,{complete:true,accepted,deckLinks:found.length,reason:accepted?undefined:'No complete official hash list available in HTML; images are not guessed.'});
    }catch(e){errors.push({source:page,error:e.message});}
    await persist();
   }
   db.coverage[site]={index:seed,discoveredPages:pages.length,newlyResolved:resolved,withoutStructuredList:imageOnly,scope:site==='Shadowverse Wins'?'Latest visible individual posts; no OCR guesses or full historical crawl.':'Current rotation tier-index linked deck guides.'};
  }catch(e){errors.push({source:seed,error:e.message});}
  await persist();
 }
}
// Check dates change daily; the revision tracks usable library content only.
db.revision=hash(deckRevisionContent([...bySignature.values()]));
if(db.revision!==previousRevision)db.syncedAt=now;
db.syncStatus=errors.length?'partial':'ok';
await persist();
console.log(JSON.stringify({saved:path,status:db.syncStatus,decks:db.decks.length,added:db.decks.length-before,changed:db.revision!==previousRevision,revision:db.revision,requests,unchanged,errors:errors.length,...(errors.length?{sourceErrors:errors}:{}),coverage:db.coverage}));
if(errors.length&&!process.argv.includes('--allow-partial'))process.exitCode=1;
