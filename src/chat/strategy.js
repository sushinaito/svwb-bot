export const isStrategyQuestion = text => /留牌|起手|換牌|换牌|攻略|打法|對局|对局|怎麼(?:玩|打)|怎么(?:玩|打)|如何(?:玩|打)|mulligan|マリガン|立ち回り|対面|matchup|how (?:do|should|to).*play|game plan/i.test(text || '');

export const STRATEGY_GUIDANCE = '攻略問題優先規則：使用者問留牌、起手、攻略、打法或對局時，必須先用 web_search 搜尋 GameWith 的 SVWB 專區（site:gamewith.jp/shadowverse-wb/），再用 web_fetch 讀實際攻略的マリガン／立ち回り段落。可用 Game8 SVWB 專區交叉確認。使用 strategy_research.searchQueries 或已知牌型日文名稱，核對遊戲是 SVWB、牌型核心、賽制、更新日期，不要混用舊 Shadowverse 或不同牌型。海賊ロイヤル與財宝ロイヤル可能是不同構築，不能只因同職業就互換。SVWB Meta 的資料成功只表示牌表／環境可用，不能取代攻略搜尋。不要拿占比、Tier 或泛泛的1～3費建議回答留牌；整理已讀攻略的具體卡名、單留／配套留牌與理由，附攻略網址和更新日期。若攻略未分先後手或職業，就明說未細分，額外推論另標示。先回答通用構築的攻略，不要把提供私人牌組代碼當成回答的前提。官方長 hash 連結讀不到不妨礙讀攻略正文；已附 decks.cards 就已有實例牌表，不能宣稱沒有完整牌表。搜尋或正文真讀不到時如實說明，不能假稱已查證，也不要退回只報人氣統計。日文卡名以本輪卡名對照轉成繁中，沒有對照者保留原名而不猜譯名。\n';

export const RESEARCH_COMPLETION_GUIDANCE = '完成查證再回答：搜尋結果摘要只是找頁面的入口。找到相關文章就自行用 web_fetch 開啟正文，沿目錄／相關連結找到問題對應段落；不要只因摘要沒寫條件，就叫使用者自行打開兩頁看。若首次讀取不完整，嘗試乾淨文章網址、同站搜尋該標題與段落關鍵字、另一個可信攻略來源，並利用本輪結構化卡名／牌表核對。仍有缺口時先給已證據支持的具體答案，再指出哪一點不能確認；不要捏造已讀全文或用泛泛建議充數。來源連結用來佐證你的結論，而不是把閱讀工作交回使用者。只有問題真正依賴使用者未提供的私人資訊，或可行查證途徑都失敗，才請求必要資料。不同語言的同一張卡可依已提供的 nameJapanese 與繁中 name 對照，不要因譯名不同就要求使用者重新證明；傷害計算要分清單張卡效果與多張卡組合。\n';

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
