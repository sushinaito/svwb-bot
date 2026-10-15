import { boundedBytes, json } from './common.js';
import { handleInteraction, ownsInteraction, verify } from './interactions.js';
import { validateCard } from './render.js';
import { state } from './state.js';
export { FunState } from './state.js';
export function createWorker(render, fetcher = fetch) {
  return { async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return json({ ok: true, service: 'svwb-fun', version: 2 });
    if (path === '/' && request.method === 'GET') return json({ service: 'SVWB custom cards', render: 'POST /v1/cards/render (Bearer token)', interactions: '/interactions' });
    if (path === '/v1/cards/render') {
      if (!env.RENDER_API_TOKEN || request.headers.get('authorization') !== `Bearer ${env.RENDER_API_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      try {
        if (!(await state(env, 'render-budget', { action: 'rate', limit: 20, dailyLimit: 300 })).ok) return json({ error: 'Render limit reached' }, 429);
        const input = JSON.parse(new TextDecoder().decode(await boundedBytes(request, 3000000)));
        const card = validateCard(input);
        const png = await render(card, env);
        return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="custom-card.png"', 'X-Content-Type-Options': 'nosniff' } });
      } catch (e) { return json({ error: e.message }, 400); }
    }
    if (path !== '/interactions') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let raw;
    try { raw = new TextDecoder().decode(await boundedBytes(request, 1000000)); } catch { return new Response('Payload too large', { status: 413 }); }
    if (!await verify(request, raw, env.DISCORD_PUBLIC_KEY)) return new Response('Invalid signature', { status: 401 });
    let i; try { i = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (i.type === 1) return json({ type: 1 });
    if (i.application_id !== env.DISCORD_APPLICATION_ID) return new Response('Wrong application', { status: 401 });
    if (ownsInteraction(i)) return handleInteraction(i, env, ctx, render, fetcher);
    // Forward the exact signed body for all existing commands and components.
    // The legacy endpoint remains deployed with its original storage and behavior.
    const old = new URL(env.LEGACY_INTERACTIONS_URL);
    if (old.protocol !== 'https:' || old.origin === new URL(request.url).origin) return new Response('Invalid legacy route', { status: 503 });
    const forward = env.LEGACY ? env.LEGACY.fetch.bind(env.LEGACY) : fetcher;
    return forward(old.href, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
      'X-Signature-Ed25519': request.headers.get('x-signature-ed25519'), 'X-Signature-Timestamp': request.headers.get('x-signature-timestamp') }, redirect: 'manual', signal: AbortSignal.timeout(2300) });
  } };
}
