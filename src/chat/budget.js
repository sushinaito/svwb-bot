import { json } from './api.js';

export const jstDay = (now = Date.now()) => new Date(now + 9 * 3600000).toISOString().slice(0, 10);

// Reserve before starting a turn, across all conversations. Unknown outcomes keep
// their reservation. Carry open reservations across JST midnight conservatively.
export function budgetStatus(state, env, now = Date.now()) {
  const day = jstDay(now);
  const reserved = Object.values(state.turns).filter(t => t.status === 'open').reduce((n, t) => n + t.reserved, 0);
  const spent = state.days[day] || 0;
  const cap = Number(env.DAILY_BUDGET_CENTS || 200);
  const margin = Number(env.BUDGET_MARGIN_CENTS || 10);
  return { day, timezone: 'Asia/Tokyo', capCents: cap, accountedCents: spent, reservedCents: reserved,
    remainingCents: Math.max(0, cap - margin - spent - reserved), marginCents: margin };
}

export function reserveTurn(state, env, id, now = Date.now()) {
  if (state.turns[id]) return { approved: state.turns[id].status === 'open', ...state.turns[id] };
  const status = budgetStatus(state, env, now);
  const allowance = Number(env.TURN_BUDGET_CENTS || 20);
  // Two cents cover rounding of cumulative cost at both ends of the turn.
  if (status.remainingCents < allowance + 2) return { approved: false,
    reason: status.capCents - status.marginCents - status.accountedCents >= allowance + 2 ? 'budget_reserved' : 'daily_budget', ...status };
  const turn = { day: status.day, allowance, reserved: allowance + 2, status: 'open' };
  state.turns[id] = turn;
  return { approved: true, ...turn };
}

export function settleTurn(state, id, cents, now = Date.now()) {
  const turn = state.turns[id];
  if (!turn || turn.status !== 'open') return;
  if (!Number.isFinite(cents) || cents < 0) throw new Error('Invalid usage');
  // A turn spanning midnight is charged to both days; never silently give it a
  // fresh allowance at rollover. This deliberately overestimates daily cost.
  for (const day of new Set([turn.day, jstDay(now)])) state.days[day] = (state.days[day] || 0) + Math.ceil(cents);
  turn.status = 'settled';
  turn.charged = Math.ceil(cents);
}

export function resetDailyBudget(state, env, input, now = Date.now()) {
  const day = jstDay(now);
  if (input.day !== day || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || '')) {
    return { error: 'Current JST day and a valid requestId are required' };
  }
  state.resets ||= {};
  const previous = state.resets[input.requestId];
  if (previous) return { ok: true, duplicate: true, reset: previous, budget: budgetStatus(state, env, now) };
  const reset = { day, at: new Date(now).toISOString(), previousAccountedCents: state.days[day] || 0 };
  state.days[day] = 0;
  state.resets[input.requestId] = reset;
  // Keep turn deduplication and open reservations: a pending reply must still
  // settle against the renewed allowance. This does not erase upstream billing.
  return { ok: true, reset, budget: budgetStatus(state, env, now) };
}

export class DailyBudget {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get('ledger') || { days: {}, turns: {} };
    });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status') return json(budgetStatus(this.state, this.env));
    const input = await request.json();
    let result = { ok: true };
    if (path === '/reserve') result = reserveTurn(this.state, this.env, input.id);
    else if (path === '/settle') settleTurn(this.state, input.id, input.cents);
    else if (path === '/reset') {
      result = resetDailyBudget(this.state, this.env, input);
      if (result.error) return json(result, 400);
    }
    else return new Response('Not found', { status: 404 });
    const oldest = jstDay(Date.now() - 7 * 86400000);
    for (const [id, turn] of Object.entries(this.state.turns)) if (turn.status === 'settled' && turn.day < oldest) delete this.state.turns[id];
    for (const day of Object.keys(this.state.days)) if (day < oldest) delete this.state.days[day];
    for (const [id, reset] of Object.entries(this.state.resets || {})) if (reset.day < oldest) delete this.state.resets[id];
    await this.ctx.storage.put('ledger', this.state);
    return json(result);
  }
}
