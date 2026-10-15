import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readJson } from '../src/chat/meta.js';

const base = 'https://shadowverse-wb.com';
const output = 'data/official-cards-cht.json';
const scratch = '.wrangler/card-cache';
const classes = ['中立', '精靈', '皇家護衛', '巫師', '龍族', '夜魔', '主教', '復仇者'];
const plain = value => String(value || '').replace(/<hr\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '');

export function normalizeCachedCard(id, detail) {
  const c = detail?.common;
  if (!/^\d{8}$/.test(id) || String(c?.card_id) !== id || !c.name || !Number.isInteger(c.cost) ||
      !Number.isInteger(c.class) || c.class < 0 || c.class > 7 || ![1,2,3,4].includes(c.type)) throw Error('Invalid official card: ' + id);
  return { id, name: plain(c.name), classId: c.class, className: classes[c.class], packId: c.card_set_id,
    cost: c.cost, rarity: c.rarity, type: c.type, typeName: {1:'從者',2:'護符',3:'護符',4:'法術'}[c.type],
    attack: c.atk, defense: c.life, isToken: !!c.is_token, legalInRotation: !!c.is_include_rotation,
    text: plain(c.skill_text), evolvedText: plain(detail.evo?.skill_text),
    voiceActorJapanese: plain(c.cv) || null, illustrator: plain(c.illustrator) || null,
    tribes: c.tribes || [], source: `${base}/cht/deck/cardslist/card/?card_id=${id}`,
    alternateStyles: (detail.style_card_list || []).map(s=>({ name: plain(s.name) || null,
      voiceActorJapanese: plain(s.cv) || null, illustrator: plain(s.illustrator) || null })) };
}

export async function downloadSnapshot({ refresh = false, fetcher = fetch, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!refresh) {
    try {
      const existing = JSON.parse(await readFile(output, 'utf8'));
      if (existing.complete && existing.cards?.length) {
        console.log(JSON.stringify({ status:'already_cached', count:existing.cards.length, fetchedAt:existing.fetchedAt }));
        return existing;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await mkdir(scratch, {recursive:true}); await mkdir('data', {recursive:true});
  const indexed = new Map(), regularIds = new Set();
  let total, packs, pages = 0;
  const startedAt = new Date().toISOString();
  for (let offset = 0; offset < (total ?? 1); offset += 30) {
    if (offset >= 6000) throw Error('Catalog exceeds download bound');
    let payload;
    // Reuse this session's inspected first page; no second download is needed.
    if (offset === 0 && !refresh) {
      try {
        const info = await stat(`${scratch}/first.json`);
        if (Date.now() - info.mtimeMs < 3600000) payload = JSON.parse(await readFile(`${scratch}/first.json`, 'utf8'));
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (!payload) {
      await pause(1500);
      const response = await fetcher(`${base}/web/CardList/cardList?offset=${offset}`, {
        headers: {lang:'cht', Referer:`${base}/cht/deck/cardslist/`, 'X-Requested-With':'XMLHttpRequest'},
        redirect:'manual', signal:AbortSignal.timeout(20000),
      });
      if (!response.ok) { await response.body?.cancel(); throw Error(`Official page stopped: HTTP ${response.status}; previous snapshot retained`); }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 2 * 1024 * 1024) throw Error('Oversized card page');
      payload = JSON.parse(new TextDecoder().decode(bytes));
      await writeFile(`${scratch}/page-${offset}.json`, JSON.stringify(payload));
    }
    const d = payload?.data;
    if (payload.data_headers?.result_code !== 1 || !Number.isInteger(d?.count) || !Array.isArray(d.sort_card_id_list) ||
        !d.card_details || d.count < 1 || d.count > 6000 || d.sort_card_id_list.length !== Math.min(30,d.count-offset)) throw Error('Incomplete official page');
    if (total !== undefined && total !== d.count) throw Error('Catalog changed during download; previous snapshot retained');
    total = d.count; packs ||= Object.entries(d.card_set_names || {}).map(([id,name])=>({id:Number(id),name:plain(name)}));
    for (const id of d.sort_card_id_list.map(String)) {
      if (regularIds.has(id) || !d.card_details[id]) throw Error('Repeated or missing catalog card');
      regularIds.add(id);
    }
    for (const [id, detail] of Object.entries(d.card_details)) {
      const card = normalizeCachedCard(id,detail), old = indexed.get(id);
      if (old && JSON.stringify(old) !== JSON.stringify(card)) throw Error('Card changed during download: ' + id);
      indexed.set(id,card);
    }
    pages++;
    console.log(JSON.stringify({page:pages,listed:regularIds.size,officialTotal:total,records:indexed.size}));
  }
  if (regularIds.size !== total) throw Error('Catalog count mismatch');
  const cards = [...indexed.values()].sort((a,b)=>a.id.localeCompare(b.id));
  const snapshot = {schemaVersion:1, language:'cht', complete:true, source:`${base}/web/CardList/cardList`,
    startedAt, fetchedAt:new Date().toISOString(), regularCount:total, tokenCount:cards.filter(c=>c.isToken).length,
    coverage:'All IDs in the official unfiltered card list, plus all related card records returned by those pages.',
    packs, cards};
  await writeFile(output+'.tmp',JSON.stringify(snapshot));
  await rename(output+'.tmp',output);
  console.log(JSON.stringify({status:'cached',regular:total,tokens:snapshot.tokenCount,records:cards.length,pages,file:output}));
  return snapshot;
}

export async function cacheAliases(snapshot, fetcher = fetch) {
  if(snapshot.aliasesCachedAt) return snapshot;
  const signal=AbortSignal.timeout(20000), manifest=await readJson('/api/manifest',fetcher,signal);
  const file=manifest.files?.cards;
  if(typeof file!=='string' || !/^[a-zA-Z0-9.-]+\.json$/.test(file) || file.includes('..')) throw Error('Invalid alias manifest');
  await new Promise(resolve=>setTimeout(resolve,1000));
  const aliases=await readJson('/data/'+file,fetcher,signal);
  let count=0;
  for(const card of snapshot.cards) {
    const names=aliases[card.id]?.names;
    const selected=Object.fromEntries(['ja','en'].filter(lang=>typeof names?.[lang]==='string' && names[lang].length<200).map(lang=>[lang,plain(names[lang])]));
    if(Object.keys(selected).length) {card.aliases=selected;count++;}
  }
  if(!count)throw Error('No matching alias IDs; official snapshot retained');
  snapshot.aliasesCachedAt=new Date().toISOString();snapshot.aliasSource='https://svwbmeta.com/data/'+file;snapshot.aliasCount=count;
  await writeFile(output+'.tmp',JSON.stringify(snapshot));await rename(output+'.tmp',output);
  console.log(JSON.stringify({status:'aliases_cached',count,source:snapshot.aliasSource}));return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  downloadSnapshot({refresh:process.argv.includes('--refresh')}).then(snapshot=>cacheAliases(snapshot)).catch(e=>{console.error(e.message);process.exitCode=1;});
}
