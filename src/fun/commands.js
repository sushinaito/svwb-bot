import { CRAFTS, EN_CRAFTS, RARITIES } from './common.js';
const craft = { type: 4, name: 'craft', description: '職業 / Craft', choices: CRAFTS.map((name, value) => ({ name: `${name} / ${EN_CRAFTS[value]}`, value })) };
const rarity = { type: 4, name: 'rarity', description: '稀有度 / Rarity', choices: RARITIES.map((name, i) => ({ name, value: i + 1 })) };
const number = (name, description, max = 99) => ({ type: 4, name, description, min_value: 0, max_value: max });
export const commands = [
  { name: 'roll', description: '擲骰子 / Roll dice', options: [{ type: 3, name: 'dice', description: '例如 1d6、2d20+3（最多 50 顆）', max_length: 24 }] },
  { name: 'random-craft', description: '隨機挑選一個職業（不含中立） / Pick a random craft' },
  { name: 'random-card', description: '隨機抽一張卡並顯示卡圖 / Pick a random card', options: [craft, number('cost', '指定費用 / Exact cost', 30), rarity,
    { type: 3, name: 'format', description: '卡池（預設指定系列） / Card pool', choices: [{ name: '指定系列 / Rotation', value: 'rotation' }, { name: '全部卡包 / All sets', value: 'all' }] },
    { type: 5, name: 'tokens', description: '也包含衍生卡 / Include tokens' },
    { type: 5, name: 'neutral', description: '指定職業時也加入中立卡 / Include Neutral' }] },
  { name: 'make-card', description: '填寫表單製作自訂卡片 PNG / Create a custom card', options: [craft,
    { type: 3, name: 'type', description: '卡片種類 / Card type', choices: [{ name: '從者', value: 'follower' }, { name: '法術', value: 'spell' }, { name: '護符', value: 'amulet' }] },
    number('cost', '費用 / Cost', 30), number('attack', '攻擊力 / Attack'), number('defense', '生命值 / Defense'), rarity,
    { type: 11, name: 'artwork', description: '立繪：PNG 或 JPG，最大 2 MB / Artwork' },
    { type: 3, name: 'style', description: '版型 / Layout', choices: [{ name: '效果圖（含卡片效果） / Effect image', value: 'effect' }, { name: '單卡圖（僅卡圖與數值） / Card image', value: 'card' }] },
    { type: 3, name: 'trait', description: '兵種類型 / Trait', max_length: 40 },
    { type: 3, name: 'illustrator', description: '畫師 / Illustrator', max_length: 40 },
    { type: 3, name: 'special', description: '特殊框 / Special frame', choices: [{ name: 'style_101', value: 'style_101' }] }] },
].map(c => ({ ...c, type: 1, contexts: [0], integration_types: [0] }));
