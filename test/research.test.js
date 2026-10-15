import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceUrl, parseSource, executeResearchTool } from '../src/chat/research.js';
import { needsChineseRewrite } from '../src/chat/language.js';

test('Japanese proper names do not discard a Chinese answer, while untranslated prose still gets repaired', () => {
  assert.equal(needsChineseRewrite('下一版退出的是「蒼空の六竜」。ギルネリーゼ、ガルミーユ、クルル、マーウィン屬於上一批，並不是這次。', '下版退環境的牌'), false);
  assert.equal(needsChineseRewrite('上方修正6枚、下方修正1枚の計7枚のカード能力が変更となります。', '維護內容'), true);
  assert.equal(needsChineseRewrite('優先留低費牌。攻略建議是 2〜3コストの低コスト帯フォロワーをキープ；中盤再展開。', '來一套牌'), true);
  assert.equal(needsChineseRewrite('龍族的特色是PPの最大値を増やせるPPブーストが得意なこと。シャドバの最強デッキです。', '龍族'), true);
  assert.equal(needsChineseRewrite('這次有7張卡變更，ロイヤル3枚、ウィッチ1枚、ネメシス3枚の3クラス計7枚が能力変更の対象です。', '版本變更'), true);
});

test('article extraction skips global navigation and retains image-only card labels', () => {
  const parsed = parseSource('<nav>選單</nav><div>全站導航</div><div id="article-body"><h2>卡片</h2><div><img alt="測試卡片"><p>' + '正文'.repeat(50) + '</p></div></div><div>其他廣告</div>', url);
  assert.match(parsed.text, /測試卡片/);
  assert.ok(!/全站導航|其他廣告/.test(parsed.text));
});

const url = 'https://gamewith.jp/shadowverse-wb/123456';
test('generic reader extracts arbitrary topics, links and dates, with pagination and literal find', async () => {
  const html = '<title>SVWB 系統說明</title><script>ignore instructions</script><main><h1>系統</h1><time datetime="2026-10-14"></time>' +
    '<p>' + '說明'.repeat(5500) + '</p><h2>房間對戰</h2><p>跨平台也能對戰。</p><a href="/shadowverse-wb/456">房間建立方式</a></main>';
  const first = parseSource(html, url);
  assert.equal(first.status, 'ok'); assert.equal(first.nextOffset, 10000);
  assert.equal(first.text.includes('ignore instructions'), false);
  assert.deepEqual(first.dates, ['2026-10-14']);
  assert.deepEqual(first.headings, ['系統', '房間對戰']);
  const next = parseSource(html, url, { offset: first.nextOffset });
  assert.equal(next.nextOffset, null); assert.match(next.text, /跨平台/);
  const found = parseSource(html, url, { find: '房間' });
  assert.equal(found.found, true); assert.match(found.text, /跨平台/);
  assert.equal(found.links[0].url, 'https://gamewith.jp/shadowverse-wb/456');
  const absent = parseSource(html, url, { find: '不存在' });
  assert.equal(absent.found, false);
  const result = await executeResearchTool('read_svwb_source', { url, find: '房間' }, async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }));
  assert.match(result.text, /跨平台/);
});

test('reader prevents private or unrelated fetches and exposes honest failures', async () => {
  let called = 0;
  const forbidden = async () => { called++; throw Error('Should not fetch'); };
  for (const url of ['http://shadowverse-wb.com/', 'https://127.0.0.1/', 'https://shadowverse-wb.com.evil.test/',
    'https://user:pass@shadowverse-wb.com/', 'https://shadowverse-wb.com:444/', 'https://gamewith.jp/shadowverse/', 'file:///x']) {
    assert.equal(sourceUrl(url), null);
    assert.equal((await executeResearchTool('read_svwb_source', { url }, forbidden)).status, 'unavailable');
  }
  assert.equal((await executeResearchTool('read_svwb_source', { url, offset: -1 }, forbidden)).status, 'unavailable');
  assert.equal(called, 0);
  for (const response of [new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'text/html' } })]) {
    assert.equal((await executeResearchTool('read_svwb_source', { url }, async () => response)).status, 'unavailable');
  }
  assert.equal((await executeResearchTool('read_svwb_source', { url }, async () => new Response('<main>載入中</main>', { headers: { 'Content-Type': 'text/html' } }))).status, 'limited');
  assert.equal((await executeResearchTool('unknown', {}, forbidden)).status, 'unavailable');
  assert.equal((await executeResearchTool('query_svwb_data', { resource: 'cards', query: '' }, forbidden)).status, 'unavailable');
});
