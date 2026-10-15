const BASE = 'https://shadowverse-wb.com';
const classNames = { 0: '中立', 1: '精靈', 2: '皇家', 3: '巫師', 4: '龍族', 5: '夢魘', 6: '主教', 7: '復仇者' };
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

export async function deckContext(text) {
  return Promise.all(deckCodes(text).map(code => lookupDeck(code)));
}
