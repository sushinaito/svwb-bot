import { CRAFTS, boundedBytes, json, message, options, randomInt, roll } from './common.js';
import { randomCard } from './cards.js';
import { validateArtwork, validateCard } from './render.js';
import { state } from './state.js';
const names = new Set(['roll', 'random-card', 'random-craft', 'make-card']);
export function ownsInteraction(i) { return i.type === 2 && names.has(i.data?.name) || i.type === 5 && /^svcard:\d+$/.test(i.data?.custom_id || ''); }
export async function verify(request, raw, publicKey, now = Date.now()) {
  const signature = request.headers.get('x-signature-ed25519'), timestamp = request.headers.get('x-signature-timestamp');
  if (!/^[a-f0-9]{128}$/i.test(signature || '') || !/^\d{10}$/.test(timestamp || '') || !/^[a-f0-9]{64}$/i.test(publicKey || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const hex = value => Uint8Array.from(value.match(/../g), x => parseInt(x, 16));
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKey), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + raw));
  } catch { return false; }
}
function modal(id) {
  const field = (custom_id, label, max_length, required = false, style = 2) => ({ type: 1, components: [{ type: 4, custom_id, label, style, required, max_length }] });
  return { type: 9, data: { custom_id: `svcard:${id}`, title: '製作自訂卡片', components: [
    field('name', '卡片名稱', 36, true, 1), field('effect', '卡片效果', 600),
    field('evolved', '進化效果（僅從者，可留空）', 300), field('superEvolved', '超進化效果（僅從者，可留空）', 300), field('author', 'DIY 作者（可留空）', 32, false, 1),
  ] } };
}
export function attachmentURL(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname) || u.port || u.username || u.password || !/^\/attachments\/\d+\/\d+\/[^/]+$/.test(u.pathname)) throw Error('無效的 Discord 立繪附件。');
  return u.href;
}
async function artwork(attachment, fetcher) {
  if (!attachment) return undefined;
  const url = attachmentURL(attachment.url);
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw Error('立繪附件已過期或無法下載，請重新使用 /make-card 上傳。');
  const bytes = await boundedBytes(response, 2 * 1024 * 1024);
  const mime = response.headers.get('content-type')?.split(';')[0];
  validateArtwork(bytes, mime);
  let binary = ''; for (let p = 0; p < bytes.length; p += 8192) binary += String.fromCharCode(...bytes.subarray(p, p + 8192));
  return `data:${mime};base64,${btoa(binary)}`;
}
async function editResponse(i, data, png, fetcher) {
  const url = `https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`;
  const payload = { ...data, allowed_mentions: { parse: [] } };
  let body, headers;
  if (png) {
    payload.attachments = [{ id: 0, filename: 'custom-card.png', description: '自訂卡片（非官方卡片）' }];
    body = new FormData(); body.set('payload_json', JSON.stringify(payload));
    body.set('files[0]', new Blob([png], { type: 'image/png' }), 'custom-card.png');
  } else { headers = { 'Content-Type': 'application/json' }; body = JSON.stringify(payload); }
  let response = await fetcher(url, { method: 'PATCH', headers, body, signal: AbortSignal.timeout(15000) });
  // PATCH the original response is idempotent. Never create a second follow-up.
  if (response.status === 429) {
    const retry = await response.json();
    if (Number(retry.retry_after) <= 3) {
      await new Promise(resolve => setTimeout(resolve, Math.ceil(retry.retry_after * 1000)));
      response = await fetcher(url, { method: 'PATCH', headers, body, signal: AbortSignal.timeout(15000) });
    }
  }
  if (!response.ok) throw Error(`Discord 回覆失敗（${response.status}）。`);
  await response.body?.cancel();
}
export async function handleInteraction(i, env, ctx, render, fetcher = fetch) {
  const user = i.member?.user?.id || i.user?.id;
  if (!user || !env.ALLOWED_GUILD_IDS.split(',').includes(i.guild_id)) return json(message('這個伺服器尚未啟用這些功能。', true));
  if (!(await state(env, `interaction:${i.id}`, { action: 'claim' })).ok) return json(message('這個操作已經處理過了。', true));
  if (!(await state(env, `user:${user}`, { action: 'rate' })).ok) return json(message('操作太頻繁，請稍後再試。', true));
  try {
    const o = options(i);
    if (i.type === 2 && i.data.name === 'roll') {
      const r = roll(o.dice); return json(message(`🎲 **${r.expression}** → ${r.rolls.join(' + ')}${r.modifier ? ` ${r.modifier > 0 ? '+' : '−'} ${Math.abs(r.modifier)}` : ''} = **${r.total}**`));
    }
    if (i.type === 2 && i.data.name === 'random-craft') return json(message(`🎲 這次玩 **${CRAFTS[randomInt(7) + 1]}**！`));
    if (i.type === 2 && i.data.name === 'make-card') {
      validateCard({ ...o, name: 'draft', artwork: undefined });
      const attachment = o.artwork ? i.data.resolved?.attachments?.[o.artwork] : null;
      if (o.artwork && !attachment) throw Error('找不到立繪附件。');
      if (attachment) {
        attachmentURL(attachment.url);
        if (!['image/png', 'image/jpeg'].includes(attachment.content_type) || attachment.size > 2 * 1024 * 1024) throw Error('立繪請使用 2 MB 以下的 PNG 或 JPG。');
      }
      await state(env, `draft:${i.id}`, { action: 'save', draft: { user, guild: i.guild_id, channel: i.channel_id, card: { ...o, artwork: undefined }, attachment } });
      return json(modal(i.id));
    }
    let draft, card;
    if (i.type === 5) {
      const taken = await state(env, `draft:${i.data.custom_id.slice(7)}`, { action: 'take', user, guild: i.guild_id, channel: i.channel_id });
      if (!taken.ok) throw Error('表單已過期或已送出，請重新使用 /make-card。');
      draft = taken.draft;
      const values = Object.fromEntries((i.data.components || []).flatMap(row => row.components || []).map(c => [c.custom_id, c.value]));
      card = validateCard({ ...draft.card, ...values });
      if (!(await state(env, 'render-budget', { action: 'rate', limit: 20, dailyLimit: 300 })).ok) throw Error('製卡服務已達使用上限，請稍後再試。');
    }
    ctx.waitUntil((async () => {
      try {
        if (i.type === 2) await editResponse(i, await randomCard(o, fetcher), null, fetcher);
        else {
          card.artwork = await artwork(draft.attachment, fetcher);
          const png = await render(card, env);
          await editResponse(i, { content: '你的自訂卡片完成了！版型與渲染：[WB 製卡器](https://sva.hypd.asia/maker/)', embeds: [{ title: card.name, image: { url: 'attachment://custom-card.png' }, footer: { text: 'DIY · 非官方卡片' } }] }, png, fetcher);
        }
      } catch (error) {
        console.error('fun_command_failed', { command: i.data?.name || 'make-card', message: String(error.message).slice(0, 200) });
        try { await editResponse(i, { content: `這次沒有完成：${String(error.message).slice(0, 300)}` }, null, fetcher); } catch { console.error('fun_error_reply_failed'); }
      }
    })());
    return json({ type: 5 });
  } catch (e) { return json(message(e.message, true)); }
}
