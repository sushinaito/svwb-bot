import { readFile } from 'node:fs/promises';
import { claude, messageText } from '../src/chat/api.js';
import { userEvent, readCost } from '../src/chat/conversation.js';
import { cardContext } from '../src/chat/cards.js';
const setup = JSON.parse(await readFile('.chat-setup.json', 'utf8'));
const version = Number(process.argv[2] || setup.agentVersion);
let session;
try {
  const text = '你確定嗎？我是問SVWB芭芭蘿絲的聲優。';
  const cards = await cardContext(text);
  if (cards?.status !== 'ok' || cards.cards[0].voiceActorJapanese !== '悠木碧') throw Error('Official card lookup failed');
  session = await claude(process.env, '/sessions', 'POST', {
    agent: { type: 'agent', id: setup.agentId, version }, environment_id: setup.environmentId,
    title: 'SVWB official card CV regression', budget: { type: 'limit', max_list_cost: { amount: '5', currency: 'USD' } },
  });
  const sent = await claude(process.env, `/sessions/${session.id}/events`, 'POST', {
    events: [userEvent({ id: 'card-check', authorId: 'test', authorName: '測試', text, cards,
      replyContext: { messageId: 'previous', text: '官方卡片頁讀不到。芭芭蘿絲可能是七龍珠芭朵絲，聲優山口由里子。請提供完整卡名。' } })],
  });
  for (let i = 0; i < 60; i++) {
    const events = await claude(process.env, `/sessions/${session.id}/events?order=asc&limit=100`);
    const n = events.data.findIndex(e => e.id === sent.data[0].id && e.processed_at);
    const current = n < 0 ? [] : events.data.slice(n);
    const end = current.find(e => e.type === 'session.status_idle');
    if (end) {
      const reply = current.filter(e => e.type === 'agent.message').map(e => messageText(e.content)).join('\n');
      const finished = await claude(process.env, `/sessions/${session.id}`);
      console.log(JSON.stringify({ version, reply, listCostCents: readCost(finished), stopReason: end.stop_reason }));
      if (end.stop_reason?.type !== 'end_turn' || !reply.includes('悠木碧') || !reply.includes('芭芭蘿絲') ||
          !reply.includes('card_id=10924110') || /請提供完整卡名/.test(reply)) throw Error('Card CV regression failed');
      break;
    }
    if (i === 59) throw Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
} catch (error) { console.error(error.status ? `HTTP ${error.status}` : error.message); process.exitCode = 1; }
finally { if (session) await claude(process.env, `/sessions/${session.id}`, 'DELETE').catch(() => console.error('Test session cleanup needs retry')); }
