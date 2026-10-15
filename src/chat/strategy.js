export const isStrategyQuestion = text => /留牌|起手|換牌|换牌|攻略|打法|對局|对局|怎麼(?:玩|打)|怎么(?:玩|打)|如何(?:玩|打)|mulligan|マリガン|立ち回り|対面|matchup|how (?:do|should|to).*play|game plan/i.test(text || '');

export function strategyResearch(text, meta) {
  if (!isStrategyQuestion(text)) return null;
  const names = meta?.strategyTargets || [];
  const topic = /留牌|起手|換牌|换牌|mulligan|マリガン/i.test(text) ? 'マリガン' : '立ち回り 攻略';
  const format = meta?.format === 'unlimited' ? 'アンリミテッド' : 'ローテーション';
  const keywords = names.length ? names.map(a => a.nameJapanese || a.name).join(' ') : String(text).slice(0, 250);
  return { required: true, targets: names, format, currentDateJST: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10),
    searchQueries: [`site:gamewith.jp/shadowverse-wb/ ${keywords} ${format} ${topic}`,
      `site:game8.jp/shadowverse-beyond/ ${keywords} ${format} ${topic}`],
    sourceRole: '攻略解說與留牌建議；公開牌表與樣本統計不是攻略證據。' };
}
