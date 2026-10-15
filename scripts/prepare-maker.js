// Pins the public browser renderer used by the user-selected WB maker.
// Downloaded third-party runtime/fonts/assets stay outside the Git source tree.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = 'https://sva.hypd.asia/maker/';
const version = 'b37a65a';
const lockPath = 'vendor/wbmaker.lock.json';
const update = process.argv.includes('--update-lock');
let lock = { source: base, version, upstreamRepository: 'https://github.com/Hypnos-PD/wbmaker', files: {} };
if (!update) lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
async function get(path) {
  const response = await fetch(base + path + '?v=' + version, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`${path}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!update && lock.files[path] !== hash) throw Error(`Upstream asset changed: ${path}`);
  lock.files[path] = hash;
  return bytes;
}
await fs.mkdir('vendor/wbmaker', { recursive: true });
await fs.mkdir('assets/wbmaker', { recursive: true });
for (const [source, target] of [['pkg/wbmaker.js', 'vendor/wbmaker/wbmaker.js'], ['pkg/wbmaker_bg.wasm', 'vendor/wbmaker/wbmaker_bg.wasm'], ['fonts/FOT-TsukuAOldMin-Pr6-E.digits.otf', 'assets/wbmaker/number.otf']]) await fs.writeFile(target, await get(source));
const manifest = JSON.parse(new TextDecoder().decode(await get('font-chunks.json')));
const packedManifest = {};
for (const key of ['cht', 'cht-sig']) {
  const files = manifest[key].files, chunks = new Array(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < files.length) { const i = next++; chunks[i] = await get(files[i].file); }
  }));
  let offset = 0;
  packedManifest[key] = files.map((file, i) => { const record = { ...file, offset, length: chunks[i].length }; offset += chunks[i].length; return record; });
  const pack = new Uint8Array(offset);
  for (let i = 0; i < files.length; i++) pack.set(chunks[i], packedManifest[key][i].offset);
  await fs.writeFile(`assets/wbmaker/${key}.bin`, pack);
  console.log(`${key}: ${files.length} font chunks, ${offset} bytes`);
}
await fs.writeFile('assets/wbmaker/fonts.json', JSON.stringify(packedManifest));
for (const cls of ['neutral', 'forestcraft', 'swordcraft', 'runecraft', 'dragoncraft', 'abysscraft', 'havencraft', 'portalcraft']) await fs.writeFile(`assets/wbmaker/${cls}.jpg`, await get(`backgrounds/${cls}-2.jpg`));
if (update) await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
console.log('Exact WB maker runtime and assets prepared.');
