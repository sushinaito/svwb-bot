import { cardCache } from './card-cache.js';
import { matchCards } from './cards.js';
import packs from '../../claude/packs.json' with {type:'json'};
import terminology from '../../claude/terminology.json' with { type:'json' };

export function cardNameMappings(text,index=cardCache.index) {
  return matchCards(text,index).slice(0,60).map(({id,card})=>({id,name:card.names['zh-Hant'],nameJapanese:card.names.ja,nameEnglish:card.names.en}));
}

// Replace only known labels. No generated paraphrase or interpretation is added.
export function localizeReplyLabels(text,input={},index=cardCache.index) {
  const pairs=new Map(), ambiguous=new Set();
  const add=(from,to)=>{
    if(!from || !to || from===to || !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(from))return;
    if(pairs.has(from) && pairs.get(from)!==to)ambiguous.add(from);
    else pairs.set(from,to);
  };
  for(const card of cardNameMappings(text,index)) {
    add(card.nameJapanese,card.name);
    add(card.nameJapanese?.replace(/[・‧·]/g,''),card.name);
  }
  for(const a of input.meta?.archetypes || [])add(a.nameJapanese,a.name);
  for(const p of packs.packs) { add(p.names.ja,p.names.cht); add(p.names.ja.replace(/[・‧·]/g,''),p.names.cht); }
  for(const t of terminology.entries)add(t.ja,t.cht);
  // A generated phonetic spelling is not the official glossary label.
  if(text.includes('克雷斯特'))pairs.set('克雷斯特',terminology.entries.find(t=>t.en==='Crest').cht);
  for(const [ja,cht] of [['ランプドラゴン','跳費龍'],['ハイランダーネメシス','單卡復仇者'],
    ['エルフ','精靈'],['ロイヤル','皇家護衛'],['ウィッチ','巫師'],['ドラゴン','龍族'],['ナイトメア','夜魔'],['ビショップ','主教'],['ネメシス','復仇者']])add(ja,cht);
  const keys=[...pairs.keys()].filter(k=>!ambiguous.has(k)).sort((a,b)=>b.length-a.length);
  if(!keys.length)return text;
  const pattern=new RegExp(keys.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
  return text.split(/(https?:\/\/[^\s<>]+)/g).map(part=>/^https?:\/\//.test(part) ? part : part.replace(pattern,key=>pairs.get(key))).join('');
}
