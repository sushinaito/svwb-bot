import { integer } from './common.js';
function text(value, max, label, required = false) {
  if (value !== undefined && typeof value !== 'string') throw Error(`${label} 必須是文字。`);
  const s = (value || '').trim();
  if ((required && !s) || [...s].length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) throw Error(`${label} 請填寫 ${required ? '1' : '0'}～${max} 個字。`);
  return s;
}
export function validateCard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('請提供卡片資料。');
  const card = { name: text(input.name, 36, '卡名', true), effect: text(input.effect, 600, '效果'),
    evolved: text(input.evolved, 300, '進化效果'), superEvolved: text(input.superEvolved, 300, '超進化效果'),
    author: text(input.author, 32, '作者'), craft: integer(input.craft ?? 0, 0, 7, '職業'),
    cost: integer(input.cost ?? 1, 0, 30, '費用'), attack: integer(input.attack ?? 1, 0, 99, '攻擊力'),
    defense: integer(input.defense ?? 1, 0, 99, '生命值'), rarity: integer(input.rarity ?? 4, 1, 4, '稀有度'),
    type: input.type ?? 'follower', style: input.style ?? 'effect',
    trait: text(input.trait, 40, '類型'), illustrator: text(input.illustrator, 40, '畫師'),
    special: input.special ?? '' };
  if (!['follower', 'spell', 'amulet'].includes(card.type)) throw Error('不支援的卡片種類。');
  if (!['card', 'effect'].includes(card.style)) throw Error('請選擇單卡圖（card）或效果圖（effect）。');
  if (!['', 'style_101'].includes(card.special)) throw Error('不支援的特殊卡框。');
  if (input.crop !== undefined) {
    const c = input.crop;
    if (!c || !['x', 'y', 'w', 'h'].every(k => typeof c[k] === 'number' && Number.isFinite(c[k])) || c.x < 0 || c.y < 0 || c.w <= 0 || c.h <= 0 || c.x + c.w > 1 || c.y + c.h > 1) throw Error('裁切範圍必須是圖片內的正規化矩形。');
    card.crop = { x: c.x, y: c.y, w: c.w, h: c.h };
  }
  if (card.type !== 'follower' && (card.evolved || card.superEvolved)) throw Error('只有從者可以填寫進化效果。');
  if (input.artwork !== undefined && input.artwork !== '') {
    if (typeof input.artwork !== 'string' || input.artwork.length > 2800000) throw Error('立繪請使用 2 MB 以下的 PNG 或 JPG。');
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.artwork);
    if (!m) throw Error('立繪請使用 PNG 或 JPG 的 base64 data URL。');
    let bytes;
    try { bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)); } catch { throw Error('立繪編碼不正確。'); }
    validateArtwork(bytes, `image/${m[1]}`);
    card.artwork = input.artwork;
  }
  return card;
}
export function validateArtwork(bytes, mime) {
  if (bytes.length > 2 * 1024 * 1024 || bytes.length < 24) throw Error('立繪大小不正確（最大 2 MB）。');
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let width, height;
  if (mime === 'image/png' && d.getUint32(0) === 0x89504e47 && d.getUint32(4) === 0x0d0a1a0a && d.getUint32(12) === 0x49484452) {
    width = d.getUint32(16); height = d.getUint32(20);
  } else if (mime === 'image/jpeg' && d.getUint16(0) === 0xffd8) {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p++] !== 0xff) break;
      while (bytes[p] === 0xff) p++;
      const marker = bytes[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = d.getUint16(p);
      if (length < 2 || p + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { height = d.getUint16(p + 3); width = d.getUint16(p + 5); break; }
      p += length;
    }
  }
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4000000) throw Error('立繪須為有效的 PNG/JPG，邊長最多 4096、總像素最多 400 萬。');
  return { width, height };
}
