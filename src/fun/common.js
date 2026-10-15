export const CRAFTS = ['中立', '精靈', '皇家護衛', '巫師', '龍族', '夜魔', '主教', '復仇者'];
export const EN_CRAFTS = ['Neutral', 'Forestcraft', 'Swordcraft', 'Runecraft', 'Dragoncraft', 'Abysscraft', 'Havencraft', 'Portalcraft'];
export const RARITIES = ['青銅', '白銀', '黃金', '傳說'];
export const json = (data, status = 200) => Response.json(data, { status });
export const message = (content, privateReply = false) => ({ type: 4, data: { content, allowed_mentions: { parse: [] }, ...(privateReply ? { flags: 64 } : {}) } });
export const options = interaction => Object.fromEntries((interaction.data?.options || []).map(o => [o.name, o.value]));
export function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`${label} 必須是 ${min}～${max} 的整數。`);
  return value;
}
export function randomInt(max, fill = a => crypto.getRandomValues(a)) {
  integer(max, 1, 1000000, '隨機範圍');
  const limit = Math.floor(0x100000000 / max) * max;
  const a = new Uint32Array(1);
  do { fill(a); } while (a[0] >= limit);
  return a[0] % max;
}
export function roll(expression = '1d6', pick = randomInt) {
  const m = /^(\d{0,2})d(\d{1,6})([+-]\d{1,4})?$/i.exec(String(expression).replace(/\s/g, ''));
  if (!m) throw Error('請輸入擲骰格式，例如 1d6、2d20+3。');
  const count = integer(Number(m[1] || 1), 1, 50, '骰子數量');
  const sides = integer(Number(m[2]), 2, 100000, '骰子面數');
  const modifier = Number(m[3] || 0);
  const rolls = Array.from({ length: count }, () => pick(sides) + 1);
  return { expression: `${count}d${sides}${modifier ? (modifier > 0 ? '+' : '') + modifier : ''}`, rolls, modifier, total: rolls.reduce((a, b) => a + b, modifier) };
}
export async function boundedBytes(response, max) {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw Error('檔案太大。'); }
  const reader = response.body?.getReader();
  if (!reader) throw Error('沒有收到資料。');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > max) throw Error('檔案太大。'); chunks.push(value);
    }
  } catch (e) { await reader.cancel(); throw e; } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let at = 0;
  for (const c of chunks) { result.set(c, at); at += c.length; }
  return result;
}
export async function readJSON(response, max = 6000000) {
  if (!response.ok) { await response.body?.cancel(); throw Error(`資料服務暫時無法使用（${response.status}）。`); }
  return JSON.parse(new TextDecoder().decode(await boundedBytes(response, max)));
}
export const plain = text => String(text || '').replace(/<hr\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/_/g, ' ');
