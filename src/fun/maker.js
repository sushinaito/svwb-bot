import { validateCard } from './render.js';
const classes = ['neutral', 'forestcraft', 'swordcraft', 'runecraft', 'dragoncraft', 'abysscraft', 'havencraft', 'portalcraft'];
const labels = ['中立', '精靈', '皇家護衛', '巫師', '龍族', '夢魘', '主教', '復仇者'];
// Preserve the website's default size for ordinary cards. Shrink only text
// that would overflow the fixed effect panel, and reject if it still cannot fit.
export function effectSize(c) {
  for (let size = 32.4; size >= 18; size -= 0.8) {
    let height = 0;
    for (const [index, value] of [c.effect, c.evolved, c.superEvolved].entries()) {
      if (!value) continue;
      let lines = 0;
      for (const para of value.replace(/\[(?:\/?[bi]|hr)\]/g, match => match === '[hr]' ? '\n\n' : '').split('\n')) {
        let width = 0;
        for (const ch of para) width += /[\u0020-\u007e]/.test(ch) ? size * 0.7 : size * 1.1;
        lines += Math.max(1, Math.ceil(width / 945));
      }
      height += lines * (size + 12) + (index ? 48 : 20);
    }
    if (c.effect && (c.evolved || c.superEvolved)) height += 28;
    if (height <= (c.illustrator ? 575 : 645)) return Math.round(size * 10) / 10;
  }
  throw Error('文字超出效果圖的可用空間，請縮短效果或減少換行。');
}
export function makerConfig(input) {
  const c = validateCard(input), size = c.style === 'effect' ? effectSize(c) : 32.4;
  return { name: c.name, language: 'cht', class: c.craft, kind: { follower: 1, amulet: 2, spell: 3 }[c.type],
    rarity: c.rarity, frame: `${c.type}_${c.special || ['bronze', 'silver', 'gold', 'legend'][c.rarity - 1]}`,
    cost: String(c.cost), atk: String(c.attack), life: String(c.defense), style: c.style === 'card' ? 'wb' : 'diy', scale: 1,
    ...(c.crop ? { crop: c.crop } : {}), bg_type: 2, bg_alpha: 0.3,
    trait_text: c.trait, class_title: '職業', class_text: labels[c.craft], type_title: '類型', illus_title: '畫師:',
    detail1: c.effect, detail2: '', show_detail2: false, evolve: c.evolved, super_evolve: c.superEvolved,
    show_evolve: Boolean(c.evolved), show_super: Boolean(c.superEvolved),
    illustrator: c.illustrator, show_illustrator: Boolean(c.illustrator), diy: c.author, show_diy: Boolean(c.author),
    d1_size: size, d2_size: size, ev_size: size, super_size: size, crests: [] };
}
export function createMakerRenderer(engine, loadAsset) {
  let manifest, numberReady = false;
  const loaded = new Set(), packs = new Map();
  async function font(prefix, group, texts) {
    const points = [...new Set([...texts.join('')].map(c => c.codePointAt(0)))];
    const needed = manifest[group].filter(f => points.some(cp => f.ranges.some(([lo, hi]) => cp >= lo && cp <= hi)));
    const missing = needed.filter(f => !loaded.has(`${prefix}:${f.file}`));
    if (!missing.length) return;
    if (!packs.has(group)) packs.set(group, await loadAsset(`${group}.bin`));
    const pack = packs.get(group);
    for (const f of missing) {
      const index = f.file.match(/(\d+)\.otf$/)[1];
      if (!engine.register_font(`${prefix}_${index}`, pack.subarray(f.offset, f.offset + f.length))) throw Error('製卡字型無法載入。');
      loaded.add(`${prefix}:${f.file}`);
    }
  }
  return async input => {
    const c = validateCard(input), cfg = makerConfig(c);
    manifest ||= JSON.parse(new TextDecoder().decode(await loadAsset('fonts.json')));
    if (!numberReady) { if (!engine.register_font('number', await loadAsset('number.otf'))) throw Error('數字字型無法載入。'); numberReady = true; }
    await font('title_cht', 'cht', Object.values(cfg).filter(v => typeof v === 'string'));
    if (c.author) await font('footnote_cht', 'cht-sig', ['※', c.author]);
    if (c.illustrator) await font('illus_cht', 'cht-sig', ['畫師:', c.illustrator]);
    const art = c.artwork ? Uint8Array.from(atob(c.artwork.split(',')[1]), ch => ch.charCodeAt(0)) : new Uint8Array(0);
    return cfg.style === 'wb' ? engine.render_card(JSON.stringify(cfg), art) : engine.render_diy_card(JSON.stringify(cfg), art, await loadAsset(`${classes[c.craft]}.jpg`));
  };
}
