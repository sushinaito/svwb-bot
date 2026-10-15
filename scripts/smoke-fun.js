import fs from 'node:fs/promises';
import { randomCard, catalog, cardPool } from '../src/fun/cards.js';
const base = process.env.FUN_URL || 'https://svwb-fun-bot.svwb-deckhelper.workers.dev';
const secrets = JSON.parse(await fs.readFile('.fun-secrets.json', 'utf8'));
const input = { name: '月光的守護者', craft: 4, cost: 5, attack: 4, defense: 6, rarity: 4,
  effect: '【守護】\n【入場曲】抽取1張卡片。\n若自己的最大PP為10，則回復自己的主戰者3點生命值。',
  evolved: '【進化時】給予1個敵方從者3點傷害。', superEvolved: '【超進化時】使自己場上的所有從者+1/+1。', author: '電競魅魔' };
if (process.argv[2]) input.artwork = `data:image/png;base64,${(await fs.readFile(process.argv[2])).toString('base64')}`;
const unauth = await fetch(base + '/v1/cards/render', { method: 'POST', body: '{}' });
if (unauth.status !== 401) throw Error('Render endpoint did not reject missing authorization');
const unsigned = await fetch(base + '/interactions', { method: 'POST', body: '{"type":1}' });
if (unsigned.status !== 401) throw Error('Interaction endpoint did not reject missing signature');
const start = Date.now();
const response = await fetch(base + '/v1/cards/render', { method: 'POST', headers: { Authorization: `Bearer ${secrets.RENDER_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
if (!response.ok) throw Error(`Render HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
const bytes = new Uint8Array(await response.arrayBuffer());
if (response.headers.get('content-type') !== 'image/png' || bytes[0] !== 137 || bytes[1] !== 80 || bytes.length < 10000) throw Error('Invalid rendered PNG');
await fs.mkdir('dist/fun', { recursive: true });
await fs.writeFile('dist/fun/live-sample-card.png', bytes);
const cards = await catalog();
const pools = Array.from({ length: 8 }, (_, craft) => cardPool(cards, { craft }).length);
if (pools.some(n => !n)) throw Error('One or more craft pools are empty');
const random = await randomCard({ craft: 4 });
const image = await fetch(random.embeds[0].image.url);
if (!image.ok || image.headers.get('content-type') !== 'image/png') throw Error('Official card image unavailable');
console.log(JSON.stringify({ renderBytes: bytes.length, elapsedMs: Date.now() - start, craftPoolSizes: pools, randomCard: random.embeds[0].title, imageStatus: image.status, authentication: 'enforced' }, null, 2));
