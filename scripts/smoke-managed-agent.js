import { readFile, writeFile } from 'node:fs/promises';
import { claude } from '../src/chat/api.js';
import { readCost } from '../src/chat/conversation.js';
import { deckContext } from '../src/chat/decks.js';

const setup = JSON.parse(await readFile('.chat-setup.json', 'utf8'));
const cap = amount => ({ type: 'limit', max_list_cost: { amount: String(amount), currency: 'USD' } });
let session;
async function turn(message, decks, ceiling) {
  if (ceiling) await claude(process.env, `/sessions/${session.id}`, 'POST', { budget: cap(ceiling) });
  const sent = await claude(process.env, `/sessions/${session.id}/events`, 'POST', {
    events: [{ type: 'user.message', content: [{ type: 'text', text: JSON.stringify({
      speaker: { name: '連線測試', id: 'test' }, message, official_deck_lookup: decks,
    }) }] }],
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    const events = await claude(process.env, `/sessions/${session.id}/events?order=asc&limit=100`);
    const index = events.data.findIndex(e => e.id === sent.data[0].id && e.processed_at);
    const current = index >= 0 ? events.data.slice(index) : [];
    const end = current.find(e => e.type === 'session.status_idle');
    if (end) {
      const response = current.filter(e => e.type === 'agent.message').flatMap(e => e.content.filter(b => b.type === 'text').map(b => b.text)).join('\n');
      const finished = await claude(process.env, `/sessions/${session.id}`);
      console.log(JSON.stringify({ model: finished.agent?.model?.id, reply: response,
        stopReason: end.stop_reason, listCostCents: readCost(finished) }));
      if (end.stop_reason?.type !== 'end_turn' || !response) throw new Error('Agent turn did not complete');
      return { response, cost: readCost(finished) };
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('Agent verification timed out');
}
try {
  const code = process.argv[2] || 'y8hf';
  const decks = await deckContext(`牌組代碼：${code}`);
  if (decks[0]?.status !== 'ok') throw new Error('Test deck is unavailable');
  session = await claude(process.env, '/sessions', 'POST', {
    agent: { type: 'agent', id: setup.agentId, version: setup.agentVersion },
    environment_id: setup.environmentId, title: 'SVWB deck chat verification', budget: cap(10),
  });
  await writeFile('.wrangler/smoke-session.json', JSON.stringify({ id: session.id }));
  const first = await turn(`Please check deck code ${code}. Briefly confirm its class, total cards and the first card's quantity. Use only the supplied official data; no web search.`, decks);
  if (!first.response.includes(String(decks[0].totalCards)) || !first.response.includes(decks[0].cards[0].name)) throw new Error('Deck facts missing');
  const second = await turn('剛才那副牌總共有幾張？再提醒我第一張卡放幾張。只用剛才的資料，兩句話就好，不要搜尋。', undefined, 15);
  if (!second.response.includes(decks[0].cards[0].name)) throw new Error('Conversation memory missing');
  const third = await turn('幫我寫一個跟遊戲完全無關的番茄炒蛋食譜。', undefined, 20);
  if (!/SVWB|闇影詩章|牌組/.test(third.response)) throw new Error('Unrelated request was not redirected');
  await writeFile('.wrangler/smoke-result.json', JSON.stringify({ sessionId: session.id, agentVersion: setup.agentVersion,
    listCostCents: third.cost, turns: 3, at: new Date().toISOString() }));
} catch (error) {
  console.error(error.status ? `Verification failed: HTTP ${error.status}` : error.message);
  process.exitCode = 1;
} finally {
  if (session?.id) await claude(process.env, `/sessions/${session.id}`, 'DELETE').catch(() => console.error('Test session cleanup needs retry'));
}
