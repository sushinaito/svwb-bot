import terminology from '../../claude/terminology.json' with { type: 'json' };

export const TERMINOLOGY_COUNT = terminology.entries.length;
export const TERMINOLOGY_GUIDANCE = `遊戲術語使用內建官方繁中詞庫。Fanfare＝入場曲、Last Words＝謝幕曲、Invoke＝瞬念召喚、Follower＝從者；不要混用戰吼、亡語或隨從。其他詞可用 query_svwb_data(resource=terminology, query=中英日術語) 查本機對照，解釋機制時用 view=definitions；不需重新抓網頁。詞庫附官方來源與核對日期，已收錄的譯名可直接使用；新詞或版本變更才查官方。此規則同樣適用於自訂卡效果欄。不要改動卡名、使用者引用或普通動詞，也不能把一般的直接召喚效果都當成「瞬念召喚」能力。\n`;

function matches(query, term) {
  const q = query.normalize('NFKC').toLowerCase();
  return [term.cht, term.en, term.ja].some(value => {
    const needle = value.normalize('NFKC').toLowerCase();
    if (!/[a-z]/.test(needle)) return q.includes(needle);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z])${escaped}(?![a-z])`).test(q);
  });
}

export function lookupTerminology(query = '', { offset = 0, limit = 12, view = 'terms' } = {}) {
  if (typeof query !== 'string' || query.length > 20000 || !Number.isInteger(offset) || offset < 0 ||
    !Number.isInteger(limit) || limit < 1 || limit > 120 || !['terms', 'definitions'].includes(view)) throw Error('Invalid terminology query');
  const exact = terminology.entries.filter(t => [t.cht, t.en, t.ja].some(s => s.normalize('NFKC').toLowerCase() === query.trim().normalize('NFKC').toLowerCase()));
  const matched = exact.length ? exact : query.trim() ? terminology.entries.filter(t => matches(query, t)) : terminology.entries;
  const page = matched.slice(offset, offset + Math.min(limit, 30));
  return { status: page.length ? 'ok' : 'not_found', verification: 'official_snapshot', verifiedAt: terminology.verifiedAt,
    sources: terminology.sources, total: matched.length, nextOffset: offset + page.length < matched.length ? offset + page.length : null,
    terms: page.map(({ cht, en, ja, definition }) => ({ cht, en, ja, ...(view === 'definitions' ? { definition } : {}) })),
    ...(!matched.length ? { message: '本機詞庫未收錄，請查官方繁中資料；不要猜譯名。' } : {}) };
}

export function relevantTerminology(text) {
  if (!text) return undefined;
  const result = lookupTerminology(text.slice(0, 20000));
  return result.status === 'ok' ? result : undefined;
}
