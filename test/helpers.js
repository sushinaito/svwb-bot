export class FakeContext {
  constructor(data = new Map()) {
    this.data = data;
    this.alarmAt = null;
    this.storage = {
      get: async key => structuredClone(this.data.get(key)),
      put: async (key, value) => { this.data.set(key, structuredClone(value)); },
      getAlarm: async () => this.alarmAt,
      setAlarm: async at => { this.alarmAt = at; },
      deleteAlarm: async () => { this.alarmAt = null; },
    };
  }
  blockConcurrencyWhile(callback) { this.ready = callback(); return this.ready; }
}

export const env = {
  DISCORD_BOT_TOKEN: 'test-discord-token', ANTHROPIC_API_KEY: 'test-claude-key',
  CLAUDE_AGENT_ID: 'agent_test', CLAUDE_AGENT_VERSION: '1', CLAUDE_ENVIRONMENT_ID: 'env_test',
  ALLOWED_GUILD_IDS: '123', DAILY_BUDGET_CENTS: '200', TURN_BUDGET_CENTS: '20',
};

export const input = (id = 'm1', extra = {}) => ({
  id, key: '123:456:789', guildId: '123', channelId: '456', authorId: '789',
  authorName: 'Player', text: 'Hello', mentioned: true, thread: false, ...extra,
});

export const message = (extra = {}) => ({
  id: 'm1', guild_id: '123', channel_id: '456', author: { id: '789', username: 'Player' },
  content: '<@999> Hello', mentions: [{ id: '999' }], type: 0, ...extra,
});
