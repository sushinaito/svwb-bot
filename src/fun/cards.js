import { CRAFTS, RARITIES, randomInt, integer, readJSON, plain } from './common.js';
let cached;
export async function catalog(fetcher = fetch) {
  if (cached?.fetcher === fetcher && cached.until > Date.now()) return cached.cards;
  const opts = { signal: AbortSignal.timeout(15000), redirect: 'error' };
  const manifest = await readJSON(await fetcher('https://svwbmeta.com/api/manifest', opts));
  const name = manifest.files?.cards;
  if (!/^cards-[a-f0-9]+\.json$/.test(name || '')) throw Error('卡片索引格式不正確。');
  const cards = await readJSON(await fetcher(`https://svwbmeta.com/data/${name}`, opts));
  if (!cards || Array.isArray(cards) || typeof cards !== 'object') throw Error('卡片索引格式不正確。');
  cached = { cards, fetcher, until: Date.now() + 300000 };
  return cards;
}
export function cardPool(cards, filters = {}) {
  if (filters.craft !== undefined) integer(filters.craft, 0, 7, '職業');
  if (filters.cost !== undefined) integer(filters.cost, 0, 30, '費用');
  if (filters.rarity !== undefined) integer(filters.rarity, 1, 4, '稀有度');
  if (!['rotation', 'all'].includes(filters.format ?? 'rotation')) throw Error('不支援的卡池。');
  return Object.entries(cards).filter(([id, c]) => /^\d{8}$/.test(id) && c.names?.['zh-Hant'] &&
    (!c.baseId || String(c.baseId) === id) && (filters.tokens || !c.isToken) &&
    (filters.format === 'all' || !c.unlimitedOnly || (filters.tokens && c.isToken)) &&
    (filters.craft === undefined || c.classId === filters.craft || (filters.neutral && c.classId === 0)) &&
    (filters.cost === undefined || c.cost === filters.cost) && (filters.rarity === undefined || c.rarity === filters.rarity));
}
export async function randomCard(filters = {}, fetcher = fetch, pick = randomInt) {
  const pool = cardPool(await catalog(fetcher), filters);
  if (!pool.length) return { content: '這些條件下沒有可抽取的卡片，試著放寬費用或稀有度。', allowed_mentions: { parse: [] } };
  const [id, c] = pool[pick(pool.length)];
  const source = `https://shadowverse-wb.com/cht/deck/cardslist/card/?card_id=${id}`;
  const hash = c.imgHash?.['zh-Hant'];
  const image = /^[a-f0-9]{30,32}$/.test(hash || '') ? `https://shadowverse-wb.com/uploads/card_image/cht/card/${hash}.png` : null;
  return { content: `🎴 從 ${pool.length} 張符合條件的卡片中等機率抽出：`, allowed_mentions: { parse: [] }, embeds: [{
    title: c.names['zh-Hant'], url: source, color: 0xc9a66a,
    description: `${CRAFTS[c.classId]} · ${c.cost} 費 · ${RARITIES[c.rarity - 1]}${c.isToken ? ' · 衍生卡' : ''}\n\n${plain(c.skill?.['zh-Hant']).slice(0, 3000)}`,
    ...(image ? { image: { url: image } } : {}),
    footer: { text: `卡池：${filters.format === 'all' ? '全部卡包' : '指定系列'}${filters.tokens ? '＋衍生卡' : '，不含衍生卡'} · 已合併異畫 · 資料：SVWB Meta` },
  }] };
}
