import snapshot from '#deck-snapshot' with {type:'json'};
import {cardCache} from './card-cache.js';
import {cardSignature} from './decks.js';

const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}]/gu,'');
const classNames=['中立','精靈','皇家護衛','巫師','龍族','夜魔','主教','復仇者'];
const classIds={妖精:1,妖:1,精靈:1,皇家:2,皇:2,皇家護衛:2,巫師:3,法:3,龍:4,龍族:4,夜魔:5,主教:6,教:6,復仇者:7,仇:7};
export function exactCardIds(name,index=cardCache.index){
 const q=normalize(name);if(!q)return [];
 return Object.entries(index).filter(([,c])=>Object.values(c.names||{}).some(n=>normalize(n)===q)).map(([id])=>id);
}
export function simpleDeckRequest(text,index=cardCache.index){
 // Intentionally narrow: extra ranking, price, exclusion or strategy conditions
 // must go to the research agent rather than being silently ignored.
 const match=String(text||'').trim().match(/^(?:請)?(?:給我|幫我找|來|推薦)(?:一|1)(?:套|副)(?:有帶|包含|帶有|有放)(.+?)的(妖精|妖|精靈|皇家護衛|皇家|皇|巫師|法|龍族|龍|夜魔|主教|教|復仇者|仇)(?:牌組|套牌|牌)?[。！!～~]?$/u);
 if(!match)return null;
 const ids=exactCardIds(match[1],index);
 return ids.length===1?{card_ids:ids,class_id:classIds[match[2]],format:'rotation'}:null;
}
export function createDeckCache(data,cards=cardCache){
 const valid=data?.schemaVersion===1&&Number.isFinite(Date.parse(data.syncedAt))&&Array.isArray(data.decks)&&data.decks.length>0&&
  new Set(data.decks.map(d=>d.id)).size===data.decks.length&&data.decks.every(d=>{
   try{const u=new URL(d.deckUrl);return u.origin==='https://shadowverse-wb.com'&&/^\/(?:cht|ja|en)\/deck\/detail\/$/.test(u.pathname)&&
    /^[1-3]\.[0-7](?:\.[A-Za-z0-9_-]{4,8}){40}$/.test(u.searchParams.get('hash')||'')&&
    Number(u.searchParams.get('hash').split('.')[1])===d.classId&&({1:'rotation',2:'unlimited',3:'infinity'}[u.searchParams.get('hash')[0]])===d.format&&cardSignature(d.cards)&&d.sources?.length&&
    d.sources.every(s=>{const link=new URL(s.url);return link.protocol==='https:'&&!link.username&&!link.password;});}catch{return false;}
  });
 const metadata=valid?{available:true,count:data.decks.length,syncedAt:data.syncedAt,revision:data.revision,storage:'private_worker_bundle',coverage:data.coverage}:{available:false};
 return {metadata,search({card_ids=[],query='',class_id,format='rotation',limit=3}={}){
  if(!valid)return {status:'unavailable',message:'尚未完成牌組快取。'};
  if(typeof query!=='string'||query.length>500||!Array.isArray(card_ids)||card_ids.length>8||card_ids.some(id=>!/^\d+$/.test(String(id)))||
   class_id!==undefined&&(!Number.isInteger(class_id)||class_id<1||class_id>7)||!['rotation','unlimited','infinity','all'].includes(format)||!Number.isInteger(limit)||limit<1||limit>10)
    return {status:'unavailable',message:'牌組搜尋條件不正確。'};
  let ids=card_ids.map(String);
  if(query){const matched=exactCardIds(query,cards.index);if(matched.length!==1)return {status:'not_found',message:'卡名尚未唯一匹配，請先確認卡片 ID；不代表不存在牌組。'};ids=[...new Set([...ids,...matched])];}
  const matches=data.decks.filter(d=>(class_id===undefined||d.classId===class_id)&&(format==='all'||d.format===format)&&ids.every(id=>d.cards.some(c=>c.id===id)))
    .sort((a,b)=>String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))||a.id.localeCompare(b.id));
  return {status:'ok',source:'local:deck-library',verification:'community_snapshot',syncedAt:data.syncedAt,total:matches.length,
   filters:{card_ids:ids,class_id,format},decks:matches.slice(0,limit).map(d=>({...d,signature:undefined,
    className:classNames[d.classId],cards:d.cards.map(c=>({...c,name:cards.get(c.id)?.name||c.id}))})),
   caveat:'收錄範圍內的公開牌表快照；相符不代表最強、目前合法或全站只有這些。沒找到只代表快取未收錄。來源與同步日期須保留。'};
 }};
}
export const deckCache=createDeckCache(snapshot);
export function cachedDeckAnswer(result){
 const d=result.decks[0],required=result.filters.card_ids.map(id=>d.cards.find(c=>c.id===id)).filter(Boolean);
 const source=d.sources[0],label=d.archetype||d.className;
 return `這套「${label}」有帶${required.map(c=>` **${c.quantity} 張${c.name}**`).join('、')}。\n\n[官方牌表](${d.deckUrl})\n來源：[${source.site}](${source.url})｜牌表快取：${result.syncedAt.slice(0,10)}\n這是符合條件的收錄牌表。`;
}
