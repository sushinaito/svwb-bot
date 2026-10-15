export class ApiError extends Error {
  constructor(service, status, retryAfter = 0) {
    super(`${service} HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function api(url, init, service, fetcher = fetch) {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    let retryAfter = Number(response.headers.get('retry-after')) || 0;
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      retryAfter = Math.max(retryAfter, Number(body.retry_after) || 0);
    } else {
      await response.body?.cancel();
    }
    // Never include request URLs, headers, payloads, or upstream bodies in errors.
    throw new ApiError(service, response.status, retryAfter);
  }
  return response.status === 204 ? null : response.json();
}

export async function discord(env, path, method = 'GET', body, fetcher) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(`https://discord.com/api/v10${path}`, {
        method,
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, 'Discord', fetcher);
    } catch (error) {
      // A 429 explicitly rejects the request, so retrying this individual chunk
      // is safe. Do not restart a long multi-message reply from its first chunk.
      if (error.status !== 429 || attempt >= 3 || error.retryAfter > 30) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.max(1000, error.retryAfter * 1000 + 100)));
    }
  }
}

export function claude(env, path, method = 'GET', body, fetcher) {
  return api(`https://api.anthropic.com/v1${path}`, {
    method,
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 'Claude', fetcher);
}

export const json = (data, status = 200) => Response.json(data, { status });
export const ids = (value) => new Set(String(value || '').split(',').map(s => s.trim()).filter(Boolean));

// Adjacent text blocks can split a sentence around citations. Preserve the
// model's own whitespace instead of inserting a newline at every block boundary.
export const messageText = content => (content || []).filter(b => b.type === 'text').map(b => b.text).join('');

export function missingConfig(env) {
  const required = ['DISCORD_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_AGENT_ID', 'CLAUDE_ENVIRONMENT_ID', 'ALLOWED_GUILD_IDS'];
  return required.filter(k => !env[k]?.trim());
}

export function splitMessage(text, limit = 1900) {
  const chunks = [];
  let rest = String(text || '').trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    // Do not split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendText(env, channelId, text, nonceSeed, replyTo) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${nonceSeed}:${i}`));
    const nonce = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
    await discord(env, `/channels/${channelId}/messages`, 'POST', {
      content: chunks[i], allowed_mentions: { parse: [], replied_user: false },
      nonce, enforce_nonce: true,
      ...(i === 0 && replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
    });
  }
}
