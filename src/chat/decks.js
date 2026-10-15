const BASE = 'https://shadowverse-wb.com';
const classNames = { 0: '中立', 1: '精靈', 2: '皇家護衛', 3: '巫師', 4: '龍族', 5: '夜魔', 6: '主教', 7: '復仇者' };
const ordinaryWords = new Set(['deck', 'code', 'this', 'that', 'with', 'help', 'look', 'give', 'what', 'have', 'your', 'from', 'list', 'card', 'svwb', 'cost', 'does', 'good', 'best', 'like', 'want', 'some', 'here', 'rate', 'play', 'tell', 'make']);

export function deckCodes(text) {
  const codes = new Set();
  for (const match of text.matchAll(/https:\/\/shadowverse-wb\.com\/[^\s<>]+/g)) {
    try {
      const url = new URL(match[0]);
      const code = url.searchParams.get('deck_code');
      if (url.hostname === 'shadowverse-wb.com' && /^[a-z0-9]{4}$/i.test(code || '')) codes.add(code);
    } catch {}
  }
  if (/^[a-z0-9]{4}$/i.test(text.trim())) codes.add(text.trim());
  if (/deck|牌組|這副牌|這套牌|代碼|牌碼/i.test(text)) {
    for (const match of text.matchAll(/(?<![a-z0-9_])[a-z0-9]{4}(?![a-z0-9_])/gi)) {
      if (!ordinaryWords.has(match[0].toLowerCase())) codes.add(match[0]);
    }
  }
  return [...codes].slice(0, 2);
}

function plain(value, limit = 5000) {
  return String(value || '').replace(/<hr\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').slice(0, limit);
}

export function normalizeDeck(payload, code) {
  const data = payload?.data;
  if (!data?.card_details || !data.deck_card_num) throw new Error('Deck unavailable');
  const entries = Object.entries(data.deck_card_num);
  if (!entries.length || entries.length > 60) throw new Error('Invalid deck');
  const cards = entries.map(([id, quantity]) => {
    const detail = data.card_details[id], c = detail?.common;
    if (!/^\d+$/.test(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 3 ||
        !c || typeof c.name !== 'string' || !Number.isInteger(c.cost) || c.cost < 0) throw new Error('Invalid card data');
    return { id, quantity, name: plain(c.name, 200), cost: c.cost, type: c.type,
      typeName: { 1: '從者', 2: '法術', 3: '護符' }[c.type],
      attack: c.atk, defense: c.life, text: plain(c.skill_text), evolvedText: plain(detail.evo?.skill_text) };
  });
  const totalCards = cards.reduce((n, c) => n + c.quantity, 0);
  if (totalCards > 60) throw new Error('Invalid deck size');
  return { code, status: 'ok', source: `${BASE}/cht/deck/build_edit/?deck_code=${encodeURIComponent(code)}`,
    retrievedAt: new Date().toISOString(), language: 'cht', classId: data.class_id, className: classNames[data.class_id],
    formatId: data.battle_format, totalCards, vials: data.total_red_ether, cards };
}

export async function lookupDeck(code, fetcher = fetch) {
  if (!/^[a-z0-9]{4}$/i.test(code)) throw new Error('Invalid deck code');
  try {
    const response = await fetcher(`${BASE}/web/DeckCode/getDeck`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', lang: 'cht',
        Referer: `${BASE}/cht/deck/build_edit/`, 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ deck_code: code }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Portal unavailable'); }
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2 * 1024 * 1024) throw new Error('Portal response too large');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel(); throw error; }
    finally { reader.releaseLock(); }
    const raw = new Uint8Array(length);
    let offset = 0;
    for (const part of chunks) { raw.set(part, offset); offset += part.length; }
    return normalizeDeck(JSON.parse(new TextDecoder().decode(raw)), code);
  } catch {
    return { code, status: 'unavailable', message: '官方牌組查詢目前無法取得這個代碼；可能已失效，或服務暫時無法使用。請使用者確認代碼或貼上牌表，不可猜測內容。' };
  }
}

async function portalJson(response) {
  if (!response.ok) { await response.body?.cancel(); throw Error('Portal unavailable'); }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw Error('Portal response too large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function cardSignature(cards) {
  if (!Array.isArray(cards) || !cards.length || cards.length > 40) return null;
  const ids = new Set(); let total = 0;
  for (const c of cards) {
    if (!/^\d+$/.test(String(c.id)) || ids.has(String(c.id)) || !Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > 3) return null;
    ids.add(String(c.id)); total += c.quantity;
  }
  return total === 40 ? cards.map(c => `${c.id}:${c.quantity}`).sort().join(',') : null;
}

export async function lookupDeckHash(deckUrl, fetcher = fetch) {
  const url = new URL(deckUrl), hash = url.searchParams.get('hash');
  if (url.origin !== BASE || !/^\/(?:cht|ja|en)\/deck\/(?:detail|build_edit)\/$/.test(url.pathname) ||
      !/^[1-3]\.[0-7](?:\.[A-Za-z0-9_-]{4,8}){40}$/.test(hash || '')) throw Error('Invalid complete deck');
  const read = async lang => portalJson(await fetcher(`${BASE}/web/DeckBuilder/deckHashDetail?hash=${encodeURIComponent(hash)}`, {
    headers: { lang, Referer: `${BASE}/cht/deck/build_edit/`, 'X-Requested-With': 'XMLHttpRequest' },
    redirect: 'manual', signal: AbortSignal.timeout(10000),
  }));
  const deck = normalizeDeck(await read('cht'), '');
  if (!cardSignature(deck.cards)) throw Error('Incomplete official deck');
  // Exact IDs link guide names to authoritative Chinese names without guessing.
  try {
    const japanese = normalizeDeck(await read('ja'), '');
    if (cardSignature(japanese.cards) === cardSignature(deck.cards)) {
      for (const card of deck.cards) card.nameJapanese = japanese.cards.find(c => c.id === card.id)?.name;
    }
  } catch { /* Chinese facts remain usable when the optional alias lookup fails. */ }
  url.pathname = '/cht/deck/detail/';
  return { ...deck, source: url.href, deckUrl: url.href, verification: 'official',
    caveat: '這份官方牌表的確切卡名、張數與卡效。日文名稱以相同卡片 ID 對照；解說使用繁中名。' };
}

// Follow the public builder's anonymous CSRF/cookie flow. Codes are temporary;
// always retain the hash link so the user can reissue one on the official site.
export async function publishDeckCode(deckUrl, expectedCards, fetcher = fetch) {
  try {
    const url = new URL(deckUrl), hash = url.searchParams.get('hash');
    if (url.origin !== BASE || !/^\/(?:cht|ja|en)\/deck\/(?:detail|build_edit)\/$/.test(url.pathname) ||
      !/^[1-3]\.[0-7](?:\.[A-Za-z0-9_-]{4,8}){40}$/.test(hash || '')) throw Error('Invalid complete deck');
    const headers = { 'Content-Type': 'application/json', lang: 'cht', Referer: `${BASE}/cht/deck/build_edit/`, 'X-Requested-With': 'XMLHttpRequest' };
    const detail = await fetcher(`${BASE}/web/DeckBuilder/deckHashDetail?hash=${encodeURIComponent(hash)}`,
      { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const payload = await portalJson(detail), original = normalizeDeck(payload, '');
    const signature = cardSignature(original.cards);
    if (!signature || (expectedCards?.length && cardSignature(expectedCards) !== signature)) throw Error('Deck mismatch');
    const token = payload.data_headers?.csrf_token;
    if (typeof token !== 'string' || !token || token.length > 500) throw Error('Missing public CSRF');
    headers['X-Csrf-Token'] = token;
    headers.Cookie = detail.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    const published = await portalJson(await fetcher(`${BASE}/web/DeckCode/publish`, {
      method: 'POST', headers, body: JSON.stringify({ hash }), redirect: 'manual', signal: AbortSignal.timeout(10000),
    }));
    const code = published.data?.deck_code;
    if (!/^[a-z0-9]{4}$/i.test(code || '')) throw Error('Code unavailable');
    const verified = await lookupDeck(code, fetcher);
    if (verified.status !== 'ok' || cardSignature(verified.cards) !== signature ||
      verified.classId !== original.classId || verified.formatId !== original.formatId) throw Error('Code mismatch');
    return { status: 'ok', code };
  } catch { return { status: 'unavailable' }; }
}

export async function deckContext(text, fetcher = fetch) {
  return Promise.all(deckCodes(text).map(code => lookupDeck(code, fetcher)));
}
