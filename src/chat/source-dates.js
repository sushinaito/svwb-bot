// Evidence signals, not automatic claims about which date an article announces.
export function sourceDates(html, body, now = Date.now()) {
  const checkedDateJST = new Date(now + 9 * 3600000).toISOString().slice(0,10);
  const currentYear = Number(checkedDateJST.slice(0,4));
  const published = new Set(), modified = new Set();
  const record = (key,value) => {
    if (typeof value !== 'string' || !/^20\d{2}[-/.年]\d{1,2}/.test(value)) return;
    if (/datePublished|published_time|pubdate/i.test(key)) published.add(value.slice(0,40));
    if (/dateModified|modified_time|updated_time/i.test(key)) modified.add(value.slice(0,40));
  };
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),m[2]]));
    record(attrs.property || attrs.name || '',attrs.content);
  }
  const walk=(value,depth=0)=>{
    if(depth>5 || !value || typeof value!=='object') return;
    for(const [key,child] of Object.entries(value).slice(0,100)) { record(key,child); if(typeof child==='object') walk(child,depth+1); }
  };
  for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if(m[1].length>200000) continue;
    try { walk(JSON.parse(m[1])); } catch { /* Malformed metadata is not evidence. */ }
  }
  const explicitDates=[], yearlessDates=[];
  const context=(m)=>body.slice(Math.max(0,m.index-45),m.index+m[0].length+65);
  for(const m of body.matchAll(/\b(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})日?/g)) {
    if(explicitDates.length>=12) break;
    explicitDates.push({date:`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`,context:context(m)});
  }
  for(const m of body.matchAll(/(?<![\d/.\-])(\d{1,2})\s*[月/]\s*(\d{1,2})日?\s*[（(]\s*([日月火水木金土一二三四五六])(?:曜日)?\s*[）)]/g)) {
    if(yearlessDates.length>=8) break;
    if(/20\d{2}\s*[年/.-]\s*$/.test(body.slice(Math.max(0,m.index-10),m.index))) continue;
    const weekday='日月火水木金土'.indexOf(m[3]);
    const dayIndex=weekday>=0 ? weekday : '日一二三四五六'.indexOf(m[3]);
    const month=Number(m[1]),day=Number(m[2]);
    const matches=year=>{ const d=new Date(Date.UTC(year,month-1,day)); return d.getUTCMonth()===month-1 && d.getUTCDate()===day && d.getUTCDay()===dayIndex; };
    yearlessDates.push({month,day,weekday:m[3],conflictsWithCurrentYear:!matches(currentYear),
      compatibleNearbyYears:[currentYear-1,currentYear,currentYear+1].filter(matches),context:context(m)});
  }
  return {checkedDateJST,publishedDates:[...published].slice(0,4),modifiedDates:[...modified].slice(0,4),explicitDates,yearlessDates,
    caveat:'日期線索需依內文確認事件。頁面修改日不是發售日，也不能證明舊段落已更新。未標年份的月日不可套入今年；星期衝突須再查年份，compatibleNearbyYears 只是日曆吻合，不證明事件年份。'};
}
