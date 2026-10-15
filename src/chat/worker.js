import { json } from './api.js';
import { metaContext } from './meta.js';
import { deckPictures, fetchDeckPicture } from './pictures.js';
export { DiscordGateway } from './gateway.js';
export { Conversation } from './conversation.js';
export { DailyBudget } from './budget.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/') return new Response('SVWB conversational bot');
    if (!['/admin/status', '/admin/start', '/admin/stop', '/admin/source-health'].includes(path)) return new Response('Not found', { status: 404 });
    if (!env.CHAT_ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.CHAT_ADMIN_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (request.method !== (path.endsWith('/status') || path.endsWith('/source-health') ? 'GET' : 'POST')) return json({ error: 'Method not allowed' }, 405);
    if (path.endsWith('/source-health')) {
      let diagnostic;
      const result = await metaContext('最近最強的龍族牌組有啥', fetch, d => { diagnostic = d; });
      const picture = deckPictures({ meta: result }, result.archetypes?.[0]?.name || '')[0];
      let image = { status: 'unavailable' };
      if (picture) {
        try { const blob = await fetchDeckPicture(picture); image = { status: 'ok', type: blob.type, bytes: blob.size }; }
        catch { image = { status: 'unavailable' }; }
      }
      return json({ status: result.status, diagnostic, window: result.window, archetypes: result.archetypes?.map(a => a.name), image });
    }
    const response = await env.GATEWAY.getByName('discord').fetch(`https://gateway${path.replace('/admin', '')}`, { method: request.method });
    if (path.endsWith('/status')) {
      const budget = await env.BUDGET.getByName('daily').fetch('https://budget/status').then(r => r.json());
      return json({ ...await response.json(), model: 'claude-haiku-5-5', budget });
    }
    return response;
  },
};
