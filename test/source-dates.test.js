import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDates } from '../src/chat/source-dates.js';

test('a recently modified page cannot turn a yearless 2025 weekday into a 2026 event',()=>{
  const result=sourceDates('<meta property="article:modified_time" content="2026-10-14T16:00:00+09:00"><script type="application/ld+json">{"datePublished":"2025-06-01"}</script>',
    '第4弾 10月29日(水) 予定。第9弾は2026年8月27日(木)発売済み。',Date.parse('2026-10-15T03:00:00Z'));
  assert.equal(result.checkedDateJST,'2026-10-15');
  assert.deepEqual(result.publishedDates,['2025-06-01']);
  assert.deepEqual(result.modifiedDates,['2026-10-14T16:00:00+09:00']);
  assert.equal(result.yearlessDates.length,1);
  assert.equal(result.yearlessDates[0].conflictsWithCurrentYear,true);
  assert.deepEqual(result.yearlessDates[0].compatibleNearbyYears,[2025]);
  assert.equal(result.explicitDates[0].date,'2026-08-27');
});

test('JST rollover and explicit years are retained independently from article metadata',()=>{
  const result=sourceDates('','2025/10/28 公告：2025年10月29日發售。',Date.parse('2026-12-31T16:00:00Z'));
  assert.equal(result.checkedDateJST,'2027-01-01');
  assert.deepEqual(result.explicitDates.map(d=>d.date),['2025-10-28','2025-10-29']);
  assert.equal(result.yearlessDates.length,0);
});
