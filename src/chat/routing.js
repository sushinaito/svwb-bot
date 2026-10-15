import { ids } from './api.js';
import { jstDay } from './budget.js';

export const THREAD_TYPES = new Set([10, 11, 12]);

export function isReplyToBot(message, botId) {
  const ref = message.message_reference, target = message.referenced_message;
  return message.type === 19 && (ref?.type ?? 0) === 0 && !!ref?.message_id &&
    (!ref.channel_id || ref.channel_id === message.channel_id) &&
    (!ref.guild_id || ref.guild_id === message.guild_id) &&
    target?.id === ref.message_id && target.author?.id === botId && !target.webhook_id &&
    (!target.channel_id || target.channel_id === message.channel_id);
}

export function routeMessage(message, botId, channel, activeThreads, env, now = Date.now()) {
  if (!message.guild_id || !ids(env.ALLOWED_GUILD_IDS).has(message.guild_id)) return null;
  if (!message.author || message.author.bot || message.webhook_id) return null;
  if (![0, 19].includes(message.type ?? 0) || !message.content?.trim()) return null;
  const mentioned = message.mentions?.some(u => u.id === botId) === true;
  const repliedToBot = isReplyToBot(message, botId);
  const thread = THREAD_TYPES.has(channel.type);
  const subscribed = thread && (activeThreads[message.channel_id]?.expires || 0) > now;
  if (!mentioned && !repliedToBot && !subscribed) return null;
  const text = message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
  if (!text) return null;
  const command = (mentioned || repliedToBot) && /^(stop|reset)$/i.test(text) ? text.toLowerCase() : null;
  return {
    key: thread ? `${message.guild_id}:${message.channel_id}` : `${message.guild_id}:${message.channel_id}:${message.author.id}`,
    id: message.id, guildId: message.guild_id, channelId: message.channel_id,
    authorId: message.author.id, authorName: message.member?.nick || message.author.global_name || message.author.username,
    text: text.slice(0, 4000), thread, mentioned, repliedToBot, command,
    ...(repliedToBot ? { replyContext: { messageId: message.referenced_message.id,
      text: String(message.referenced_message.content || '').slice(0, 4000) } } : {}),
  };
}

export function admitMessage(state, message, env, now = Date.now()) {
  if (state.seen?.includes(message.id)) return 'duplicate';
  const day = jstDay(now);
  if (state.day !== day) { state.day = day; state.count = 0; }
  state.users ||= {};
  for (const [id, times] of Object.entries(state.users)) {
    state.users[id] = times.filter(t => t > now - 60000);
    if (!state.users[id].length) delete state.users[id];
  }
  const times = state.users[message.authorId] || [];
  if (times.length >= 5 || state.count >= Number(env.DAILY_MESSAGE_LIMIT || 100)) return 'limited';
  state.count++;
  state.users[message.authorId] = [...times, now];
  state.seen = [...(state.seen || []), message.id].slice(-1000);
  return 'accepted';
}
