import * as engine from '../../vendor/wbmaker/wbmaker.js';
import wasm from '../../vendor/wbmaker/wbmaker_bg.wasm';
import { createMakerRenderer } from './maker.js';
let renderer;
export class CardRenderer {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    // Serialize image decoding and rendering to bound peak memory. The DO's
    // CPU allowance also accommodates image composition on Workers Free.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (!renderer) {
          engine.initSync({ module: wasm });
          renderer = createMakerRenderer(engine, async name => {
            const r = await this.env.ASSETS.fetch(`https://assets/wbmaker/${name}`);
            if (!r.ok) throw Error('製卡素材無法載入。');
            return new Uint8Array(await r.arrayBuffer());
          });
        }
        const png = await renderer(await request.json());
        return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      } catch (error) { return Response.json({ error: String(error.message || error).slice(0, 300) }, { status: 400 }); }
    });
  }
}
export async function renderCard(input, env) {
  const r = await env.RENDERER.getByName('renderer').fetch('https://renderer/', { method: 'POST', body: JSON.stringify(input) });
  if (!r.ok) throw Error((await r.json()).error || '製卡失敗。');
  return new Uint8Array(await r.arrayBuffer());
}
