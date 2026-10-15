import { discord, messageNonce } from './api.js';
import { publishDeckCode } from './decks.js';

export function deckImageUrl(deckUrl) {
  try {
    const url = new URL(deckUrl), hash = url.searchParams.get('hash');
    if (url.protocol !== 'https:' || url.hostname !== 'shadowverse-wb.com' ||
        !/^\/(?:cht|ja|en)\/deck\/(?:detail|build_edit)\/$/.test(url.pathname) ||
        !/^[1-3]\.[0-7](?:\.[A-Za-z0-9_-]{4,8}){1,60}$/.test(hash || '')) return null;
    return `https://shadowverse-wb.com/web/Image/deck?hash=${encodeURIComponent(hash)}&lang=cht`;
  } catch { return null; }
}

export function collectDeliveryDecks(result) {
  if (result?.status !== 'ok') return [];
  const metaDecks = (result.archetypes || []).flatMap(a => (a.decks || []).filter(d => deckImageUrl(d.deckUrl)).map(d => ({
    deckUrl: d.deckUrl, label: `${a.className || result.className || '牌組'}・${a.name}`,
    source: result.source,
    ...(d.cards ? { cards: d.cards.map(c => ({ id: c.id, quantity: c.quantity })) } : {}),
  })));
  const linkedDecks = (result.links || []).filter(l => deckImageUrl(l.url)).map(l => ({
    deckUrl: l.url, label: '牌組', source: result.source,
  }));
  const exactDeck = deckImageUrl(result.deckUrl) ? [{ deckUrl: result.deckUrl, label: result.className || '牌組', source: result.source, cards: result.cards }] : [];
  return [...exactDeck, ...metaDecks, ...linkedDecks].slice(0, 16);
}

export function deckPictures(input, answer) {
  const pictures = new Map();
  const add = (url, label, cards) => {
    const imageUrl = deckImageUrl(url);
    if (imageUrl && !pictures.has(imageUrl)) {
      const localized = new URL(url); localized.pathname = '/cht/deck/detail/';
      pictures.set(imageUrl, { imageUrl, deckUrl: localized.href, label, cards });
    }
  };
  const candidates = [...(input.deliveryDecks || []), ...collectDeliveryDecks(input.meta)];
  // Only an explicitly linked build is selected, never every archetype fetched
  // during research or a similarly named build mentioned in a comparison.
  for (const match of answer.matchAll(/https:\/\/shadowverse-wb\.com\/[^\s<>\])]+/g)) {
    const candidate = candidates.find(d => deckImageUrl(d.deckUrl) === deckImageUrl(match[0]));
    add(match[0], candidate?.label || '牌組', candidate?.cards);
  }
  return [...pictures.values()].slice(0, 2);
}

export function localizeDeckLinks(answer) {
  return answer.replace(/https:\/\/shadowverse-wb\.com\/[^\s<>\])]+/g, raw => {
    if (!deckImageUrl(raw)) return raw;
    const url = new URL(raw); url.pathname = '/cht/deck/detail/';
    return url.href;
  });
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

export async function sendDeckPictures(env, input, answer, fetcher = fetch, { linksInAnswer = false } = {}) {
  const pictures = deckPictures(input, answer);
  if (!pictures.length) return;
  const ready = await Promise.all(pictures.map(async picture => {
    const [image, code] = await Promise.allSettled([fetchDeckPicture(picture, fetcher), publishDeckCode(picture.deckUrl, picture.cards, fetcher)]);
    return { ...picture, blob: image.status === 'fulfilled' ? image.value : null,
      code: code.status === 'fulfilled' && code.value.status === 'ok' ? code.value.code : null };
  }));
  const attached = ready.filter(p => p.blob);
  const form = new FormData();
  const linkLabel = linksInAnswer ? '上方的官方牌表' : '官方牌表';
  const payload = { content: ready.map((p, i) => `${ready.length > 1 ? `${i + 1}. ${p.label}\n` : ''}${p.code ? `牌組代碼：\`${p.code}\`` : `暫時無法取得牌組代碼，可從${linkLabel}重新發行。`}${linksInAnswer ? '' : `\n[官方牌表](<${p.deckUrl}>)`}${p.blob ? '' : '\n牌組圖暫時無法載入。'}`).join('\n\n') +
      (ready.some(p => p.code) ? `\n\n若代碼失效，請開啟${linkLabel}重新發行。` : ''),
    allowed_mentions: { parse: [], replied_user: false }, flags: 4,
    nonce: await messageNonce(`${input.id}:deck-pictures`), enforce_nonce: true,
    message_reference: { message_id: input.id, fail_if_not_exists: false },
    attachments: attached.map((p,i) => ({ id: i, filename: `deck-${i + 1}.png`, description: `${p.label}繁中牌組圖片` })),
  };
  form.set('payload_json', JSON.stringify(payload));
  attached.forEach((p,i) => form.set(`files[${i}]`, p.blob, `deck-${i + 1}.png`));
  await discord(env, `/channels/${input.channelId}/messages`, 'POST', attached.length ? form : payload);
}
