import { discord, messageNonce } from './api.js';

export function deckImageUrl(deckUrl) {
  try {
    const url = new URL(deckUrl), hash = url.searchParams.get('hash');
    if (url.protocol !== 'https:' || url.hostname !== 'shadowverse-wb.com' ||
        !/^\/(?:cht|ja|en)\/deck\/(?:detail|build_edit)\/$/.test(url.pathname) ||
        !/^[1-3]\.[0-7](?:\.[A-Za-z0-9_-]{4,8}){1,60}$/.test(hash || '')) return null;
    return `https://shadowverse-wb.com/web/Image/deck?hash=${encodeURIComponent(hash)}&lang=cht`;
  } catch { return null; }
}

export function deckPictures(input, answer) {
  const pictures = new Map();
  const add = (url, label) => {
    const imageUrl = deckImageUrl(url);
    if (imageUrl && !pictures.has(imageUrl)) pictures.set(imageUrl, { imageUrl, deckUrl: url, label });
  };
  for (const archetype of input.meta?.archetypes || []) for (const deck of archetype.decks || []) {
    if (answer.includes(archetype.name) || answer.includes(deck.deckUrl)) add(deck.deckUrl, `${archetype.className || input.meta.className || '牌組'}・${archetype.name}`);
  }
  for (const match of answer.matchAll(/https:\/\/shadowverse-wb\.com\/[^\s<>\])]+/g)) add(match[0], '牌組');
  return [...pictures.values()].slice(0, 2);
}

export async function fetchDeckPicture(picture, fetcher = fetch) {
  if (deckImageUrl(picture.deckUrl) !== picture.imageUrl) throw Error('Invalid deck image');
  const response = await fetcher(picture.imageUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
    await response.body?.cancel(); throw Error('Deck image unavailable');
  }
  const reader = response.body.getReader(), parts = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 5 * 1024 * 1024) throw Error('Deck image too large');
      parts.push(value);
    }
  } catch (e) { await reader.cancel(); throw e; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  if (bytes.length < 1024 || ![137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) throw Error('Invalid PNG');
  return new Blob([bytes], { type: 'image/png' });
}

export async function sendDeckPictures(env, input, answer, fetcher = fetch) {
  const pictures = deckPictures(input, answer);
  if (!pictures.length) return;
  const results = await Promise.allSettled(pictures.map(async picture => ({ ...picture, blob: await fetchDeckPicture(picture, fetcher) })));
  const ready = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ready.length) return; // The answer's original clickable links remain available.
  const form = new FormData();
  const payload = { content: ready.map((p, i) => `${i + 1}. ${p.label}：[牌表](<${p.deckUrl}>)`).join('\n'),
    allowed_mentions: { parse: [], replied_user: false }, flags: 4,
    nonce: await messageNonce(`${input.id}:deck-pictures`), enforce_nonce: true,
    message_reference: { message_id: input.id, fail_if_not_exists: false },
    attachments: ready.map((p,i) => ({ id: i, filename: `deck-${i + 1}.png`, description: `${p.label}繁中牌組圖片` })),
  };
  form.set('payload_json', JSON.stringify(payload));
  ready.forEach((p,i) => form.set(`files[${i}]`, p.blob, `deck-${i + 1}.png`));
  await discord(env, `/channels/${input.channelId}/messages`, 'POST', form);
}
