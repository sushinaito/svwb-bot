import { json } from './api.js';
import { metaContext } from './meta.js';
import { deckPictures, fetchDeckPicture } from './pictures.js';
import { imageBlock } from './vision.js';
import { cardContext } from './cards.js';
import { guideContext } from './guides.js';
export { DiscordGateway } from './gateway.js';
export { Conversation } from './conversation.js';
export { DailyBudget } from './budget.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/') return new Response('SVWB conversational bot');
    if (!['/admin/status', '/admin/start', '/admin/stop', '/admin/source-health', '/admin/budget-reset'].includes(path)) return new Response('Not found', { status: 404 });
    if (!env.CHAT_ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.CHAT_ADMIN_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (request.method !== (path.endsWith('/status') || path.endsWith('/source-health') ? 'GET' : 'POST')) return json({ error: 'Method not allowed' }, 405);
    if (path.endsWith('/budget-reset')) {
      let input;
      try { input = await request.json(); } catch { return json({ error: 'JSON body required' }, 400); }
      return env.BUDGET.getByName('daily').fetch('https://budget/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
    }
    if (path.endsWith('/source-health')) {
      let diagnostic;
      const result = await metaContext('最近最強的龍族牌組有啥', fetch, d => { diagnostic = d; });
      const overview = await metaContext('現在比賽和排位最多人用的牌組是？');
      const card = await cardContext('芭芭蘿絲的聲優是誰？');
      const strategy = await metaContext('海賊皇怎麼留牌');
      const guide = await guideContext('海賊皇怎麼留牌', strategy);
      const picture = deckPictures({ meta: result }, result.archetypes?.[0]?.name || '')[0];
      let image = { status: 'unavailable' };
      if (picture) {
        try {
          const blob = await fetchDeckPicture(picture);
          const block = imageBlock(new Uint8Array(await blob.arrayBuffer()), blob.type);
          image = { status: 'ok', type: blob.type, bytes: blob.size, visionEncoding: block.source.type };
        }
        catch { image = { status: 'unavailable' }; }
      }
      return json({ status: result.status, diagnostic, window: result.window, archetypes: result.archetypes?.map(a => a.name), image, card,
        strategy: { status: strategy?.status, targets: strategy?.strategyTargets, totalCards: strategy?.archetypes?.[0]?.decks?.[0]?.cards?.reduce((n,c) => n + c.quantity, 0),
          guide: { status: guide?.status, source: guide?.guides?.[0]?.source, updatedAt: guide?.guides?.[0]?.updatedAt, sections: guide?.guides?.[0]?.sections?.map(s => s.heading) } },
        overview: { status: overview?.status, scope: overview?.scope, sampledBuilds: overview?.sampledBuilds,
          classCount: overview?.classes?.length, topArchetypes: overview?.archetypes?.slice(0, 3).map(a => ({ name: a.name, sampledBuilds: a.sampledBuilds })),
          tournament: overview?.tournament, strength: overview?.strength } });
    }
    const response = await env.GATEWAY.getByName('discord').fetch(`https://gateway${path.replace('/admin', '')}`, { method: request.method });
    if (path.endsWith('/status')) {
      const budget = await env.BUDGET.getByName('daily').fetch('https://budget/status').then(r => r.json());
      return json({ ...await response.json(), model: 'claude-haiku-5-5', budget });
    }
    return response;
  },
};
