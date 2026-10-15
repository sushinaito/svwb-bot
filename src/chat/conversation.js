import { claude, discord, json, sendText } from './api.js';
import { deckContext } from './decks.js';

const cap = cents => ({ type: 'limit', max_list_cost: { amount: String(cents), currency: 'USD' } });
const userEvent = input => ({ type: 'user.message', content: [{ type: 'text', text: JSON.stringify({
  discord_message_id: input.id,
  speaker: { id: input.authorId, name: input.authorName },
  message: input.text,
  ...(input.decks?.length ? { official_deck_lookup: input.decks } : {}),
}) }] });

export async function eventsSince(env, sessionId, since) {
  const events = [];
  let page;
  for (let count = 0; count < 20; count++) {
    const query = new URLSearchParams({ limit: '100', order: 'asc' });
    if (since) query.set('created_at[gte]', since);
    if (page) query.set('page', page);
    const result = await claude(env, `/sessions/${sessionId}/events?${query}`);
    events.push(...result.data);
    page = result.next_page;
    if (!page) return events;
  }
  throw new Error('Event history exceeded polling bound');
}

export class Conversation {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.running = false;
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get('conversation') || { queue: [], seen: [] };
    });
  }

  save() { return this.ctx.storage.put('conversation', this.state); }

  async budget(path, body) {
    const response = await this.env.BUDGET.getByName('daily').fetch(`https://budget${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Budget service unavailable');
    return response.json();
  }

  async fetch(request) {
    const input = await request.json();
    if (this.state.seen.includes(input.id)) return json({ accepted: true, duplicate: true });
    if (!this.state.ownerId) this.state.ownerId = input.authorId;
    if (input.command === 'reset' && input.thread && input.authorId !== this.state.ownerId) {
      await sendText(this.env, input.channelId, '只有開啟這段對話的人可以清除紀錄喔。', input.id, input.id);
      return json({ accepted: false });
    }
    if (this.state.blocked && input.command !== 'reset') {
      await sendText(this.env, input.channelId, '這段對話暫停了。開啟對話的人可以用 @我 加上 `reset` 清除紀錄後重試，仍會受到每日預算限制。', input.id, input.id);
      return json({ accepted: false });
    }
    if (this.state.queue.length >= 8) {
      await sendText(this.env, input.channelId, '我還有幾則訊息正在回覆，等一下再傳喔。', input.id, input.id);
      return json({ accepted: false });
    }
    this.state.seen = [...this.state.seen, input.id].slice(-1000);
    this.state.queue.push(input);
    await this.save();
    if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 100);
    return json({ accepted: true });
  }

  async alarm() {
    if (this.running) return;
    this.running = true;
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    try {
      await this.tick();
      if (this.state.current) this.state.current.failures = 0;
    } catch (error) {
      const job = this.state.current;
      if (job) {
        job.failures = (job.failures || 0) + 1;
        job.retryAt = Date.now() + (error.retryAfter || 0) * 1000;
        // Do not retry ambiguous POSTs. The 'sending' phase reconciles the event
        // history on the next alarm; 'creating' fails closed after a restart.
        if (job.failures >= 6 || [400, 401, 403, 404].includes(error.status)) {
          await this.fail('AI 服務連線失敗，這段對話暫停了。開啟對話的人可以用 @我 加上 `reset` 後重試。');
        }
      }
      console.log('chat_tick_failed', { status: error.status || null, phase: job?.phase || null });
    } finally {
      this.running = false;
      await this.save();
      if (this.state.current || this.state.queue.length) {
        await this.ctx.storage.setAlarm(Math.max(this.state.current?.retryAt || 0,
          Date.now() + Math.min(60000, 5000 * 2 ** (this.state.current?.failures || 0))));
      } else await this.ctx.storage.deleteAlarm();
    }
  }

  async tick() {
    if (!this.state.current) {
      const input = this.state.queue.shift();
      if (!input) return;
      this.state.current = { input, phase: 'prepare', startedAt: Date.now(), seenEvents: [], outputChars: 0 };
      await this.save();
    }
    const job = this.state.current;
    if (job.input.command === 'reset') { await this.reset(); return; }
    if (this.state.blocked) {
      await sendText(this.env, job.input.channelId, '這段對話暫停了，請先用 @我 加上 `reset` 清除紀錄。', job.input.id, job.input.id);
      this.state.current = null;
      return;
    }
    if (Date.now() - job.startedAt > 5 * 60000) {
      await this.fail('這次回覆等太久了，我先停止處理。請用 @我 加上 `reset` 後重試。');
      return;
    }

    if (job.phase === 'prepare') {
      if (this.state.sessionId) {
        const session = await claude(this.env, `/sessions/${this.state.sessionId}`);
        if (session.status !== 'idle') throw new Error('Session is not idle');
        job.baseline = readCost(session);
      } else job.baseline = 0;
      const reservation = await this.budget('/reserve', { id: job.input.id });
      if (!reservation.approved) {
        await sendText(this.env, job.input.channelId, '今天的 AI 預算（2 美元）已用完，或已預留給正在處理的回覆。請稍後再試；預算會在日本時間午夜重設。', job.input.id, job.input.id);
        this.state.current = null;
        return;
      }
      job.reservation = reservation;
      job.capCents = job.baseline + reservation.allowance;
      job.phase = this.state.sessionId ? 'update-budget' : 'create';
      await this.save();
    }

    if (job.phase === 'create') {
      job.phase = 'creating';
      await this.save();
      const session = await claude(this.env, '/sessions', 'POST', {
        agent: { type: 'agent', id: this.env.CLAUDE_AGENT_ID, version: Number(this.env.CLAUDE_AGENT_VERSION || 1) },
        environment_id: this.env.CLAUDE_ENVIRONMENT_ID,
        title: `Discord ${job.input.thread ? 'thread' : 'conversation'} ${job.input.channelId}`,
        budget: cap(job.capCents),
      });
      this.state.sessionId = session.id;
      job.phase = 'send';
      await this.save();
    } else if (job.phase === 'creating') {
      await this.fail('建立對話時中斷了，請用 @我 加上 `reset` 後重試。');
      return;
    }

    if (job.phase === 'update-budget') {
      await claude(this.env, `/sessions/${this.state.sessionId}`, 'POST', { budget: cap(job.capCents) });
      job.phase = 'send';
      await this.save();
    }

    if (job.phase === 'send') {
      if (!job.input.decks) job.input.decks = await deckContext(job.input.text);
      job.since = this.state.cursorTime || null;
      job.phase = 'sending';
      job.sentAt = Date.now();
      await this.save();
      const result = await claude(this.env, `/sessions/${this.state.sessionId}/events`, 'POST', { events: [userEvent(job.input)] });
      job.userEventId = result.data[0].id;
      job.phase = 'poll';
      await this.save();
    }

    if (job.phase === 'sending') {
      const expected = userEvent(job.input).content[0].text;
      const events = await eventsSince(this.env, this.state.sessionId, job.since);
      const sent = events.find(e => e.type === 'user.message' && e.content?.some(b => b.text === expected));
      if (sent) { job.userEventId = sent.id; job.phase = 'poll'; await this.save(); }
      else if (Date.now() - job.sentAt > 60000) await this.fail('目前無法確認 AI 是否收到訊息，為了避免重複送出，我先暫停對話。請用 @我 加上 `reset` 後重試。');
      return;
    }

    if (job.phase === 'poll') await this.poll();
    if (job.phase === 'settle') await this.finish();
  }

  async poll() {
    const job = this.state.current;
    if (Date.now() - (job.typedAt || 0) > 8000) {
      await discord(this.env, `/channels/${job.input.channelId}/typing`, 'POST').catch(() => {});
      job.typedAt = Date.now();
    }
    const events = await eventsSince(this.env, this.state.sessionId, job.since);
    // A new session can emit idle before the first user event is processed.
    // Ignore all history until this turn's accepted event is encountered.
    if (!job.userProcessed) {
      const ownIndex = events.findIndex(e => e.id === job.userEventId && e.processed_at);
      if (ownIndex < 0) return;
      // Keep earlier events excluded on subsequent polls too.
      job.seenEvents.push(...events.slice(0, ownIndex).map(e => e.id));
    }
    for (const event of events) {
      if (!event.processed_at || job.seenEvents.includes(event.id)) continue;
      if (event.id === job.userEventId) job.userProcessed = true;
      if (!job.userProcessed) continue;
      if (event.type === 'agent.message') {
        const text = (event.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
        const remaining = Math.max(0, 12000 - job.outputChars);
        if (text && remaining) {
          await sendText(this.env, job.input.channelId, text.slice(0, remaining), `${job.input.id}:${event.id}`, job.input.id);
          job.outputChars += Math.min(text.length, remaining);
        }
      }
      if (event.type === 'session.error' || event.type === 'session.status_terminated') {
        await this.fail('AI 服務意外停止了，請用 @我 加上 `reset` 後重試。');
        return;
      }
      if (event.type === 'session.status_idle') {
        const reason = event.stop_reason?.type || event.stop_reason;
        if (reason === 'end_turn') job.phase = 'settle';
        else if (reason === 'budget_reached') {
          this.state.blocked = 'turn_budget';
          job.notice = '這次回覆已達單次預算上限。可以用 @我 加上 `reset` 清除紀錄，再使用今天剩餘的預算繼續。';
          job.phase = 'settle';
        } else if (reason === 'requires_action') {
          this.state.blocked = 'requires_action';
          job.notice = '這次操作需要目前沒有開放的工具權限，請用 @我 加上 `reset` 重新開始。';
          job.phase = 'settle';
        }
      }
      job.seenEvents.push(event.id);
      this.state.cursorTime = event.processed_at;
      await this.save();
      if (job.phase === 'settle') break;
    }
  }

  async finish() {
    const job = this.state.current;
    const session = await claude(this.env, `/sessions/${this.state.sessionId}`);
    if (session.status !== 'idle') return;
    // Reported costs are rounded to cents. Add one cent to the difference so
    // reclaiming a reservation does not underestimate the true turn cost.
    const charged = Math.max(0, readCost(session) - job.baseline) + 1;
    await this.budget('/settle', { id: job.input.id, cents: charged });
    if (job.notice || !job.outputChars) {
      await sendText(this.env, job.input.channelId, job.notice || '這次沒有產生文字回覆，可以換個方式再問一次嗎？', `${job.input.id}:done`, job.input.id);
    }
    this.state.current = null;
    await this.save();
  }

  async fail(message) {
    const job = this.state.current;
    if (!job) return;
    this.state.blocked = 'error';
    if (this.state.sessionId) {
      await claude(this.env, `/sessions/${this.state.sessionId}/events`, 'POST', { events: [{ type: 'user.interrupt' }] }).catch(() => {});
    }
    // Keep an uncertain cost reservation until reset. No new agent requests
    // can run in this conversation while it is blocked.
    if (job.reservation) this.state.unsettled = { id: job.input.id, reserved: job.reservation.reserved };
    await sendText(this.env, job.input.channelId, message, `${job.input.id}:failed`, job.input.id);
    this.state.current = null;
    await this.save();
  }

  async reset() {
    const job = this.state.current;
    if (this.state.sessionId) {
      // Deleting the session also removes its saved transcript and sandbox.
      try { await claude(this.env, `/sessions/${this.state.sessionId}`, 'DELETE'); }
      catch (error) { if (error.status !== 404) throw error; }
      delete this.state.sessionId;
      await this.save();
    }
    if (this.state.unsettled) {
      // Unknown outcome: charge the full reservation; never refund on reset.
      await this.budget('/settle', { id: this.state.unsettled.id, cents: this.state.unsettled.reserved });
    }
    delete this.state.sessionId;
    delete this.state.cursorTime;
    delete this.state.blocked;
    delete this.state.unsettled;
    await this.save();
    await sendText(this.env, job.input.channelId, '對話紀錄清掉了！想聊哪副牌，或哪個 SVWB 問題？', job.input.id, job.input.id);
    this.state.current = null;
    await this.save();
  }
}

export function readCost(session) {
  const cost = session.usage?.list_cost;
  if (cost?.currency !== 'USD' || !/^\d+$/.test(cost.amount)) throw new Error('Missing session usage');
  return Number(cost.amount);
}
