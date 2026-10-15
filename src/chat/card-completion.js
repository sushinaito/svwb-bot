import {FUN_TOOLS} from './fun.js';
import {TERMINOLOGY_GUIDANCE} from './terminology.js';
export const CARD_COMPLETION_VERSION=1;

// An execution guard for explicit artifact requests, not a character/topic list.
// Only the user's own message grants permission; evidence and old memory don't.
export function requestedCustomCard(text='') {
  const value=String(text).trim();
  if(/只(?:要|需|用|寫|做)[^。\n]{0,30}文字|(?:不要|不用|無須)(?:製作|產生|生成|出|做|畫)?(?:圖|圖片|卡圖)|(?:text|written)[ -]?only|(?:do not|don't|no)\s+(?:render|image|picture)/i.test(value))return false;
  if(/^(?:請問)?(?:你)?(?:能|可以|會)(?:幫我)?(?:做|製作|設計|diy)(?:自訂)?(?:卡片|卡牌|卡)(?:嗎)?[?？]?$/i.test(value)||/^can you (?:make|create|render|design|draw) (?:a |an |custom )*cards?\??$/i.test(value))return false;
  return /(?:(?:幫我|替我|請|麻煩)(?:做|製作|制作|設計|生成|畫)|(?:來|給我|我要|做成|製作|制作|生成)(?:一張|張|個|卡)|(?:make|create|render|design|draw)\s+(?:me\s+)?(?:a|an|one|the|this|custom)\b)[\s\S]{0,120}(?:卡片|卡牌|自訂卡|自制卡|自製卡|DIY.?卡|card\b)/i.test(value);
}

export function deliveredCustomCard(job) {
  return Object.values(job.customCards||{}).some(c=>c.result?.status==='ok'&&c.result.delivered);
}

export const CARD_COMPLETION_TOOLS=FUN_TOOLS.filter(t=>t.name==='make_custom_card');
export const CARD_COMPLETION_SYSTEM=`完成使用者已要求的自訂卡片圖片。研究階段已結束，只能用現有證據設計並呼叫 make_custom_card，不能再搜尋、查資料或要求使用者代查。創意數值與能力是你設計的，不是官方卡文。人物事實只用已取得證據，未確認不要編造。
必須呼叫 make_custom_card 產出實際 PNG，不能只列文字設計或聲稱完成。工具前可用一個短段落說明人物設定與設計理由，附支持人物設定的來源連結；隨後立即呼叫工具，填好卡名、職業、費用、種類、數值及效果。同一張卡用 card_slot=1，多張才分配其他 slots。
current_attachments 是本輪附件；單張圖片自動作為立繪，不要因為舊對話提到圖片失敗，就要求重傳或移除。vision_status 只描述 AI 看圖狀態，製卡服務可獨立讀取附件；即使看圖失敗仍須嘗試製卡，不能假裝看過圖片內容。只有使用者明確要求空白立繪才能 clear_artwork=true。新卡不要沿用舊卡；使用者要求修改上一張時才 reuse_previous=true。
沿用 completed_research_answer 內已設計的卡片數值與效果，不為收尾任意重設。工具結果 unavailable 時精確處理該錯誤，不宣稱成功。不要說「如果要圖片再傳PNG」、不要只交文字設計。
`+TERMINOLOGY_GUIDANCE;

export function renderedCardAnswer(results,explanation='') {
  const names=results.map(r=>`「${r.result.card.name}」`).join('、');
  const art=results.some(r=>r.result.artwork==='user attachment');
  return `已製作${names}的卡片圖片${art?'，並使用本輪附件作為立繪':''}。`+(explanation.trim()?`\n\n${explanation.trim()}`:'');
}
