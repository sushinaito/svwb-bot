import data from '../../claude/packs.json' with { type: 'json' };

export const packMetadata = {
  storage: 'bundled_json', verifiedAt: data.verifiedAt, count: data.packs.length,
  latestReleasedInSnapshot: (() => { const p=data.packs.at(-1); return {id:p.id,ordinal:p.ordinal,name:p.names.cht,releasedOn:p.releasedOn}; })(),
  caveat: '歷史發售紀錄截至 verifiedAt，不是即時公告清單；下一版或新卡包的確切日期仍須查當期官方公告。不能把已發售包當成下一包。',
};

export const packById = id => data.packs.find(p=>p.id===Number(id));

export function lookupPacks(query='', {offset=0,limit=30,filters={}}={}) {
  if(typeof query!=='string' || query.length>500 || !Number.isInteger(offset) || offset<0 || !Number.isInteger(limit) || limit<1 || limit>120) throw Error('Invalid pack query');
  if(Object.keys(filters).some(key=>key!=='pack_id')) throw Error('Packs support only the pack_id filter');
  const q=query.normalize('NFKC').toLowerCase().trim();
  const ordinal=q.match(/^第?\s*(\d+)\s*[彈弾包]$/)?.[1];
  const matches=data.packs.filter(p=>(filters.pack_id===undefined || p.id===filters.pack_id) &&
    (!q || (ordinal ? p.ordinal===Number(ordinal) : [String(p.id),...Object.values(p.names),p.releasedOn].some(s=>s.toLowerCase().includes(q)))));
  const packs=matches.slice(offset,offset+Math.min(limit,30));
  return {status:'ok',verification:'curated_snapshot',...packMetadata,query,offset,total:matches.length,
    nextOffset:offset+packs.length<matches.length ? offset+packs.length : null,packs,basicSet:data.basicSet,
    sourceCautions:data.sourceCautions,
    caveat:packMetadata.caveat+' 名稱、ID、卡數來自官方；發售日期依每筆 releaseDateEvidence 標示，community_reported 表示社群記載，不能冒稱已獲官方逐項確認。'};
}
