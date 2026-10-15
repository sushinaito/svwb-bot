import { json } from './api.js';
export { DiscordGateway } from './gateway.js';
export { Conversation } from './conversation.js';
export { DailyBudget } from './budget.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/') return new Response('SVWB conversational bot');
    if (!['/admin/status', '/admin/start', '/admin/stop'].includes(path)) return new Response('Not found', { status: 404 });
    if (!env.CHAT_ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.CHAT_ADMIN_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (request.method !== (path.endsWith('/status') ? 'GET' : 'POST')) return json({ error: 'Method not allowed' }, 405);
    const response = await env.GATEWAY.getByName('discord').fetch(`https://gateway${path.replace('/admin', '')}`, { method: request.method });
    if (path.endsWith('/status')) {
      const budget = await env.BUDGET.getByName('daily').fetch('https://budget/status').then(r => r.json());
      return json({ ...await response.json(), model: 'claude-haiku-5-5', budget });
    }
    return response;
  },
};
