import fs from 'node:fs/promises';
import * as engine from '../vendor/wbmaker/wbmaker.js';
import { createMakerRenderer } from '../src/fun/maker.js';
const wasm = engine.initSync({ module: await fs.readFile('vendor/wbmaker/wbmaker_bg.wasm') });
const render = createMakerRenderer(engine, name => fs.readFile(`assets/wbmaker/${name}`));
const card = { name: '月光的守護者', craft: 4, cost: 5, attack: 4, defense: 6,
  effect: '【守護】\n【入場曲】抽取1張卡片。\n若自己的最大PP為10，則回復自己的主戰者3點生命值。',
  evolved: '【進化時】給予1個敵方從者3點傷害。', superEvolved: '【超進化時】使自己場上的所有從者+1/+1。', author: '電競魅魔' };
if (process.argv[2]) card.artwork = `data:image/png;base64,${(await fs.readFile(process.argv[2])).toString('base64')}`;
await fs.mkdir('dist/fun', { recursive: true });
for (const style of ['card', 'effect']) {
  const png = await render({ ...card, style });
  await fs.writeFile(`dist/fun/maker-${style}.png`, png);
  console.log({ style, bytes: png.length, wasmMemoryMB: wasm.memory.buffer.byteLength / 1024 / 1024 });
}
