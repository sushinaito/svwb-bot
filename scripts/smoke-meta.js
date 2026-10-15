import { readFile, writeFile } from 'node:fs/promises';
import { claude, messageText } from '../src/chat/api.js';
import { userEvent, readCost } from '../src/chat/conversation.js';
import { metaContext } from '../src/chat/meta.js';
const setup = JSON.parse(await readFile('.chat-setup.json', 'utf8'));
const version = Number(process.argv[2] || setup.agentVersion);
const overview = process.argv[3] === 'overview';
let session;
try {
  const text = overview ? '現在比賽和排位最多人用的牌組是？' : '可以查最新的龍族牌組嗎';
  const meta = await metaContext(text);
  if (meta?.status !== 'ok' || !meta.archetypes.some(a => a.name === '跳費龍') ||
      (overview && (meta.classes?.length !== 7 || meta.tournament?.status !== 'ok'))) throw Error('Live metadata lookup failed');
  console.log(JSON.stringify({ lookup: meta.status, window: meta.window, archetypes: meta.archetypes.map(a => a.name) }));
  session = await claude(process.env, '/sessions', 'POST', {
    agent: { type: 'agent', id: setup.agentId, version }, environment_id: setup.environmentId,
    title: overview ? 'SVWB cross-class tournament regression' : 'SVWB current Dragon deck regression',
    budget: { type: 'limit', max_list_cost: { amount: overview ? '5' : '20', currency: 'USD' } },
  });
  const sent = await claude(process.env, `/sessions/${session.id}/events`, 'POST', {
    events: [userEvent({ id: 'meta-check', authorId: 'test', authorName: '測試', text, meta,
      ...(overview ? { replyContext: { messageId: 'previous-reply', text: '目前無法確認比賽和排位最多人用的是哪套。SVWB Meta 讀取失敗，只查到龍族、主教；沒有全職業使用率。請告訴我職業。' } } : {}) })],
  });
  for (let i = 0; i < 60; i++) {
    const events = await claude(process.env, `/sessions/${session.id}/events?order=asc&limit=100`);
    const n = events.data.findIndex(e => e.id === sent.data[0].id && e.processed_at);
    const current = n < 0 ? [] : events.data.slice(n);
    const end = current.find(e => e.type === 'session.status_idle');
    if (end) {
      const reply = current.filter(e => e.type === 'agent.message').map(e => messageText(e.content)).join('\n');
      const prose = reply.replace(/https?:\/\/[^\s)]+/g, '');
      const longEnglish = /\b[A-Za-z]+(?:[ ,;:\-]+[A-Za-z]+){8,}/.test(prose);
      const finished = await claude(process.env, `/sessions/${session.id}`);
      const result = { agentVersion: version, effort: finished.agent?.model?.effort, reply, longEnglish,
        window: meta.window, listCostCents: readCost(finished), stopReason: end.stop_reason };
      console.log(JSON.stringify(result));
      await writeFile(`.wrangler/meta-${overview ? 'overview-' : ''}check-v${version}.json`, JSON.stringify(result, null, 2));
      if (end.stop_reason?.type !== 'end_turn' || longEnglish || !reply.includes('跳費龍') ||
          reply.includes('坡道') || !reply.includes('https://svwbmeta.com')) throw Error('Live Chinese metadata regression failed');
      if (overview && (!reply.includes('BCL') || !reply.includes(String(meta.sampledBuilds)) ||
          !reply.includes(String(meta.tournament.submittedDecks)) || !reply.includes(meta.archetypes[0].name) ||
          !reply.includes(meta.tournament.archetypes[0].name) || !/全服/.test(reply))) throw Error('Missing overview evidence or ranked-ladder distinction');
      break;
    }
    if (i === 59) throw Error('Timed out');
    await new Promise(r => setTimeout(r, 3000));
  }
} catch (e) { console.error(e.status ? `HTTP ${e.status}` : e.message); process.exitCode = 1; }
finally { if (session) await claude(process.env, `/sessions/${session.id}`, 'DELETE').catch(() => console.error('Test session cleanup needs retry')); }
