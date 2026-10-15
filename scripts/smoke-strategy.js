import { readFile, writeFile } from 'node:fs/promises';
import { claude, messageText } from '../src/chat/api.js';
import { userEvent, readCost } from '../src/chat/conversation.js';
import { metaContext } from '../src/chat/meta.js';
import { guideContext } from '../src/chat/guides.js';
const setup = JSON.parse(await readFile('.chat-setup.json', 'utf8'));
const version = Number(process.argv[2] || setup.agentVersion);
let session;
try {
  const text = '海賊皇怎麼留牌';
  const meta = await metaContext(text);
  const guides = await guideContext(text, meta);
  if (guides?.status !== 'ok' || !guides.guides[0].sections.some(s => s.text.includes('副船長'))) throw Error('Direct guide reading failed');
  if (meta?.status !== 'ok' || meta.archetypes[0]?.decks[0]?.cards?.reduce((n,c) => n + c.quantity, 0) !== 40) throw Error('Strategy deck lookup failed');
  session = await claude(process.env, '/sessions', 'POST', {
    agent: { type: 'agent', id: setup.agentId, version }, environment_id: setup.environmentId,
    title: 'SVWB GameWith mulligan regression', budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
  });
  const sent = await claude(process.env, `/sessions/${session.id}/events`, 'POST', {
    events: [userEvent({ id: 'strategy-check', authorId: 'test', authorName: '測試', text, meta, guides,
      replyContext: { messageId: 'previous', text: '官方長連結打不開，無法讀到海賊皇完整牌表。GameWith與Game8有攻略，但搜尋摘要沒有具體留牌條件，建議你直接打開這兩頁查看，再提供牌組代碼。' } })],
  });
  for (let i = 0; i < 80; i++) {
    const events = await claude(process.env, `/sessions/${session.id}/events?order=asc&limit=100`);
    const n = events.data.findIndex(e => e.id === sent.data[0].id && e.processed_at);
    const current = n < 0 ? [] : events.data.slice(n);
    const end = current.find(e => e.type === 'session.status_idle');
    if (end) {
      const reply = current.filter(e => e.type === 'agent.message').map(e => messageText(e.content)).join('\n');
      const finished = await claude(process.env, `/sessions/${session.id}`);
      await writeFile('.wrangler/strategy-events.json', JSON.stringify(current, null, 2));
      const toolCalls = current.filter(e => e.type === 'agent.tool_use');
      const result = { version, reply, listCostCents: readCost(finished), stopReason: end.stop_reason,
        searched: toolCalls.some(e => e.name === 'web_search'), fetched: toolCalls.some(e => e.name === 'web_fetch'), directGuide: guides.guides[0].source };
      await writeFile('.wrangler/strategy-result.json', JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      if (end.stop_reason?.type !== 'end_turn' || !reply.includes('https://gamewith.jp/shadowverse-wb/') ||
          !['海域斥候', '渦潮砲手', '波濤副船長'].every(name => reply.includes(name)) ||
          /建議你.{0,5}(?:打開|查看)|請(?:你)?自行|請提供牌組代碼|無法讀到.{0,8}完整牌表/.test(reply) ||
          !guides.guides[0].sections.some(s => /マリガン/.test(s.heading))) throw Error('Strategy research did not complete with concrete sourced advice');
      break;
    }
    if (i === 79) throw Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
} catch (error) { console.error(error.status ? `HTTP ${error.status}` : error.message); process.exitCode = 1; }
finally { if (session) await claude(process.env, `/sessions/${session.id}`, 'DELETE').catch(() => console.error('Test session cleanup needs retry')); }
