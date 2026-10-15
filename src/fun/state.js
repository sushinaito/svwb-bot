import { json } from './common.js';
export class FunState {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const { action, ...input } = await request.json();
    const now = Date.now();
    return this.ctx.storage.transaction(async storage => {
      if (action === 'claim') {
        if (await storage.get('claimed')) return json({ ok: false });
        await storage.put('claimed', true); await storage.setAlarm(now + 20 * 60000);
        return json({ ok: true });
      }
      if (action === 'rate') {
        const window = Math.floor(now / 60000), day = Math.floor(now / 86400000);
        const prior = await storage.get('rate') || {};
        const count = prior.window === window ? prior.count : 0;
        const daily = prior.day === day ? prior.daily : 0;
        if (count >= (input.limit || 10) || daily >= (input.dailyLimit || 300)) return json({ ok: false });
        await storage.put('rate', { window, count: count + 1, day, daily: daily + 1 });
        await storage.setAlarm(now + 86400000);
        return json({ ok: true });
      }
      if (action === 'save') {
        await storage.put('draft', { ...input.draft, until: now + 15 * 60000 });
        await storage.setAlarm(now + 20 * 60000); return json({ ok: true });
      }
      if (action === 'take') {
        const draft = await storage.get('draft');
        if (!draft || draft.until < now || draft.user !== input.user || draft.guild !== input.guild || draft.channel !== input.channel) return json({ ok: false });
        await storage.delete('draft'); return json({ ok: true, draft });
      }
      return json({ ok: false });
    });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
export async function state(env, key, data) {
  return env.STATE.getByName(key).fetch('https://state/', { method: 'POST', body: JSON.stringify(data) }).then(r => r.json());
}
