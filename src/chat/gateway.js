import { discord, json, missingConfig, sendText } from './api.js';
import { routeMessage, admitMessage, THREAD_TYPES } from './routing.js';

// One outbound Gateway connection for this Discord application. Outbound sockets
// cannot hibernate; the alarm restores the connection after deploys/eviction.
export class DiscordGateway {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.socket = null;
    this.serial = Promise.resolve();
    this.ready = false;
    this.connecting = false;
    this.heartbeatTimer = null;
    this.latestSequence = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get('gateway') || { enabled: false, threads: {}, pending: [], limits: {} };
    });
  }

  save() { return this.ctx.storage.put('gateway', this.state); }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status') return json({
      enabled: this.state.enabled, connected: this.ready,
      botId: this.state.botId || null, lastReadyAt: this.state.lastReadyAt || null,
      lastError: this.state.lastError || null, pendingMessages: this.state.pending.length,
      messagesToday: this.state.limits.count || 0, missing: missingConfig(this.env),
      allowedGuildIds: String(this.env.ALLOWED_GUILD_IDS || '').split(',').filter(Boolean),
      messageEditsSupported: true,
      botRoleMentionsSupported: true,
      agentVersion: Number(this.env.CLAUDE_AGENT_VERSION || 1),
    });
    if (path === '/stop') {
      this.state.enabled = false;
      this.state.resume = null;
      await this.save();
      this.disconnect();
      await this.ctx.storage.deleteAlarm();
      return json({ enabled: false, note: 'No new messages accepted. Already queued conversations may finish.' });
    }
    if (path === '/start') {
      const missing = missingConfig(this.env);
      if (missing.length) return json({ error: 'Configuration incomplete', missing }, 409);
      this.state.enabled = true;
      this.state.lastError = null;
      this.state.retryAt = 0;
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json({ enabled: true, connecting: true });
    }
    return new Response('Not found', { status: 404 });
  }

  async alarm() {
    if (!this.state.enabled) return;
    // Schedule before network I/O so transient failures cannot strand the actor.
    await this.ctx.storage.setAlarm(Date.now() + 30000);
    if (!this.socket && !this.connecting && Date.now() >= (this.state.retryAt || 0)) {
      try { await this.connect(); }
      catch (error) { await this.connectionFailed(error.status ? `Discord HTTP ${error.status}` : 'Gateway connection failed'); }
    }
    if (this.socket && !this.ready && Date.now() - this.connectedAt > 60000) {
      await this.connectionFailed('Gateway handshake timed out');
    }
    this.serial = this.serial.then(() => this.drain()).catch(() => {});
    await this.serial;
  }

  async connect() {
    this.connecting = true;
    try {
      const gateway = await discord(this.env, '/gateway/bot');
      if (!this.state.resume && gateway.session_start_limit?.remaining === 0) {
        this.state.retryAt = Date.now() + gateway.session_start_limit.reset_after;
        this.state.lastError = 'Discord session-start limit reached';
        await this.save();
        return;
      }
      const rawUrl = this.state.resume?.url || gateway.url;
      const url = new URL(rawUrl);
      if (url.protocol !== 'wss:' || !/(^|\.)discord\.gg$/.test(url.hostname)) throw new Error('Invalid Gateway URL');
      url.protocol = 'https:';
      url.search = '?v=10&encoding=json';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let response;
      try { response = await fetch(url, { headers: { Upgrade: 'websocket' }, signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      const socket = response.webSocket;
      if (!socket) throw new Error('Gateway upgrade failed');
      this.socket = socket;
      this.connectedAt = Date.now();
      this.acknowledged = true;
      this.latestSequence = this.state.resume?.seq ?? null;
      socket.addEventListener('message', event => {
        if (this.socket !== socket) return;
        let packet;
        try { packet = JSON.parse(event.data); } catch { this.disconnect(); return; }
        if (packet.s != null) this.latestSequence = packet.s;
        // Heartbeats never wait for REST delivery or conversation processing.
        if (packet.op === 11) { this.acknowledged = true; return; }
        if (packet.op === 1) { this.heartbeat(false); return; }
        this.serial = this.serial.then(async () => {
          if (this.socket === socket) await this.packet(packet);
        }).catch(async () => { await this.connectionFailed('Gateway event handling failed'); });
      });
      socket.addEventListener('close', event => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.ready = false;
        clearTimeout(this.heartbeatTimer);
        this.serial = this.serial.then(async () => {
          if ([4004, 4010, 4011, 4013, 4014].includes(event.code)) {
            this.state.enabled = false;
            this.state.lastError = `Discord closed Gateway (${event.code}); check bot token and Message Content Intent`;
            await this.ctx.storage.deleteAlarm();
          } else {
            if ([4007, 4009, 1000, 1001].includes(event.code)) this.state.resume = null;
            this.state.retryAt = Date.now() + 5000;
            this.state.lastError = `Gateway disconnected (${event.code})`;
          }
          await this.save();
        }).catch(() => {});
      });
      socket.addEventListener('error', () => {
        if (this.socket === socket) this.disconnect();
      });
      socket.accept();
    } finally { this.connecting = false; }
  }

  disconnect() {
    clearTimeout(this.heartbeatTimer);
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    try { socket?.close(4000, 'Reconnecting'); } catch {}
  }

  async connectionFailed(reason) {
    this.disconnect();
    this.state.failures = Math.min((this.state.failures || 0) + 1, 6);
    this.state.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** this.state.failures);
    this.state.lastError = reason;
    await this.save();
  }

  send(op, d) { this.socket?.send(JSON.stringify({ op, d })); }

  heartbeat(checkAck = true) {
    if (!this.socket) return;
    if (checkAck && !this.acknowledged) { this.disconnect(); return; }
    this.acknowledged = false;
    this.send(1, this.latestSequence);
  }

  scheduleHeartbeat(delay) {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeat();
      if (this.socket) this.scheduleHeartbeat(this.heartbeatInterval);
    }, delay);
  }

  async packet(packet) {
    if (packet.op === 10) {
      this.heartbeatInterval = packet.d.heartbeat_interval;
      this.scheduleHeartbeat(Math.random() * this.heartbeatInterval);
      const resume = this.state.resume;
      if (resume) this.send(6, { token: this.env.DISCORD_BOT_TOKEN, session_id: resume.id, seq: resume.seq });
      else this.send(2, {
        token: this.env.DISCORD_BOT_TOKEN,
        // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT. DMs are deliberately off.
        intents: 1 | 512 | 32768,
        properties: { os: 'linux', browser: 'svwb-chat', device: 'svwb-chat' },
      });
      return;
    }
    if (packet.op === 7 || packet.op === 9) {
      if (packet.op === 9 && !packet.d) this.state.resume = null;
      this.state.retryAt = Date.now() + 5000;
      await this.save();
      this.disconnect();
      return;
    }
    if (packet.op !== 0) return;
    if (packet.t === 'READY') {
      this.state.botId = packet.d.user.id;
      this.state.resume = { id: packet.d.session_id, url: packet.d.resume_gateway_url, seq: packet.s };
    }
    if (['READY', 'RESUMED'].includes(packet.t)) {
      this.ready = true;
      this.state.lastReadyAt = new Date().toISOString();
      this.state.lastError = null;
      this.state.failures = 0;
    }
    if (packet.t === 'MESSAGE_CREATE') await this.receive(packet.d);
    if (packet.t === 'MESSAGE_UPDATE') await this.receiveEdit(packet.d);
    if (packet.t === 'THREAD_DELETE') delete this.state.threads[packet.d.id];
    // Persist the replay cursor only after the message has been durably queued.
    if (this.state.resume) this.state.resume.seq = packet.s;
    await this.save();
    await this.drain();
  }

  async receiveEdit(update) {
    if (!update.guild_id || !String(this.env.ALLOWED_GUILD_IDS).split(',').map(s => s.trim()).includes(update.guild_id)) return;
    // Embed refreshes also emit updates. Only explicit content edits matter.
    if (typeof update.content !== 'string' || !update.edited_timestamp || !update.id || !update.channel_id) return;
    if (this.state.limits.seen?.includes(update.id) || this.state.pending.some(m => m.id === update.id)) return;
    if (update.author?.bot || update.webhook_id) return;
    if (!update.mentions?.some(u => u.id === this.state.botId) && !update.mention_roles?.length && !this.state.threads[update.channel_id] &&
          !new RegExp(`<@!?${this.state.botId}>`).test(update.content) && !/<@&\d+>/.test(update.content)) return;
    // Update payloads can omit author/type/mentions. Fetch the complete current
    // message and route it through the same guild, author and budget guards.
    let message;
    try { message = await discord(this.env, `/channels/${update.channel_id}/messages/${update.id}`); }
    catch (error) { if ([403, 404].includes(error.status)) return; throw error; }
    if (message.id !== update.id || message.channel_id !== update.channel_id) return;
    await this.receive({ ...message, guild_id: update.guild_id });
  }

  async receive(message) {
    if (!message.guild_id || !String(this.env.ALLOWED_GUILD_IDS).split(',').map(s => s.trim()).includes(message.guild_id)) return;
    if (message.author?.bot || message.webhook_id || !message.content) return;
    message = await this.normalizeBotRoleMention(message);
    const mentioned = message.mentions?.some(u => u.id === this.state.botId);
    for (const [id, entry] of Object.entries(this.state.threads)) if (entry.expires < Date.now()) delete this.state.threads[id];
    if (!mentioned && !this.state.threads[message.channel_id]) return;
    const channel = this.state.threads[message.channel_id] ? { type: 11 } : await discord(this.env, `/channels/${message.channel_id}`);
    const input = routeMessage(message, this.state.botId, channel, this.state.threads, this.env);
    if (!input) return;
    if (this.state.pending.some(m => m.id === input.id)) return;
    if (input.command === 'stop' && input.thread) {
      const owner = this.state.threads[input.channelId]?.owner;
      if (owner && owner !== input.authorId) return;
      delete this.state.threads[input.channelId];
      await this.save();
      await sendText(this.env, input.channelId, '我先不自動回覆這個討論串了，想繼續聊時再 @我 就好。', input.id, input.id);
      return;
    }
    const limits = structuredClone(this.state.limits);
    const admission = admitMessage(limits, input, this.env);
    if (admission !== 'accepted') {
      if (admission === 'limited' && mentioned) await sendText(this.env, input.channelId, '目前已達聊天次數限制，請稍後再試喔。', input.id, input.id);
      return;
    }
    if (this.state.pending.length >= 50) throw new Error('Delivery queue full');
    if (input.thread) {
      const existing = this.state.threads[input.channelId];
      if (!existing && THREAD_TYPES.has(channel.type)) {
        // Joining enables subsequent thread events, including private threads the bot can access.
        await discord(this.env, `/channels/${input.channelId}/thread-members/@me`, 'PUT');
      }
      this.state.threads[input.channelId] = { owner: existing?.owner || input.authorId, expires: Date.now() + Number(this.env.THREAD_IDLE_HOURS || 24) * 3600000 };
    }
    this.state.limits = limits;
    this.state.pending.push(input);
    await this.save();
  }

  async drain() {
    if (!this.state.enabled) return;
    for (const input of this.state.pending.slice(0, 5)) {
      const response = await this.env.CONVERSATIONS.getByName(input.key).fetch('https://conversation/message', {
        method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error('Conversation enqueue failed');
      this.state.pending = this.state.pending.filter(m => m.id !== input.id);
      await this.save();
    }
  }

  async normalizeBotRoleMention(message) {
    if (!message.mention_roles?.length || message.mentions?.some(u => u.id === this.state.botId)) return message;
    this.state.botRoles ||= {};
    let entry = this.state.botRoles[message.guild_id];
    if (!entry || Date.now() - entry.checkedAt > 3600000) {
      const roles = await discord(this.env, `/guilds/${message.guild_id}/roles`);
      entry = { checkedAt: Date.now(), ids: roles.filter(r => r.managed && r.tags?.bot_id === this.state.botId).map(r => r.id) };
      this.state.botRoles[message.guild_id] = entry;
    }
    const matched = entry.ids.filter(id => message.mention_roles.includes(id));
    if (!matched.length) return message;
    let content = message.content;
    for (const id of matched) content = content.replaceAll(`<@&${id}>`, `<@${this.state.botId}>`);
    return { ...message, content, mentions: [...(message.mentions || []), { id: this.state.botId }] };
  }
}
