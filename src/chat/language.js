export function needsChineseRewrite(answer, request) {
  if (/(?:請|用|以|改成|回答|reply|respond|answer).{0,30}(?:英文|英語|日文|日語|English|Japanese)|(?:English|Japanese)\s*(?:please|only)/i.test(request)) return false;
  const prose = answer.replace(/https?:\/\/[^\s)]+/g, '')
    // Short quoted names and link labels can legitimately remain Japanese.
    .replace(/[「《〈]([^」》〉\n]{1,60})[」》〉]/g, (all, name) =>
      (name.match(/[\u3041-\u3096]/g) || []).length <= 3 ? '' : all);
  return /\b[A-Za-z]+(?:[ ,;:\-]+[A-Za-z]+){8,}/.test(prose) ||
    // Katakana card/set names are not untranslated prose. Look for sustained
    // Japanese grammar within a sentence instead of counting names globally.
    prose.split(/[。！？\n]/).some(sentence => {
      const hiragana = (sentence.match(/[\u3041-\u3096]/g) || []).length;
      const katakana = (sentence.match(/[\u30a1-\u30faー]/g) || []).length;
      return (hiragana >= 3 && /(?:です|ます|ません)(?:[、」』）)]|$)/.test(sentence)) ||
        (katakana >= 12 && /[\u30a1-\u30faー]{2,}[のをがにでと][\p{L}\d]{2,}/u.test(sentence)) ||
        (hiragana >= 8 && hiragana / Math.max(1, (sentence.match(/\p{L}/gu) || []).length) >= 0.15);
    });
}

export const rewriteEvent = () => ({ type: 'user.message', content: [{ type: 'text', text:
  '上一則答案尚未傳給使用者，因為含有未翻譯的英文或日文敘述。請只將上一則答案改寫成自然的台灣繁體中文，保留已查證的資訊、日期、限制與實際來源連結，不要新增事實或再次搜尋。使用已提供的繁中卡名與牌型，Ramp 是跳費。只輸出整理後可直接傳送的答案，不要道歉或解釋改寫過程。',
}] });
