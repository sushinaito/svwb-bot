import { readFile, writeFile } from 'node:fs/promises';
import { claude, messageText } from '../src/chat/api.js';
import { Conversation, readCost, eventsSince } from '../src/chat/conversation.js';
import { DailyBudget } from '../src/chat/budget.js';
import { FakeContext } from '../test/helpers.js';
import { needsChineseRewrite } from '../src/chat/language.js';
import { deckImageUrl } from '../src/chat/pictures.js';
import terminology from '../claude/terminology.json' with { type: 'json' };

const setup = JSON.parse(await readFile('.chat-setup.json', 'utf8'));
const config = JSON.parse(await readFile('wrangler.chat.local.json', 'utf8'));
const realFetch = globalThis.fetch;
const cases = [
  { name: 'rules-existing-session', text: 'SVWB 超進化和一般進化差在哪？先手後手各從第幾回合能用？', old: true },
  { name: 'game-system', text: '剛開始玩 SVWB，想跟朋友對戰要怎麼開房間？手機和電腦能一起玩嗎？' },
  { name: 'rotation-regression', text: '下版退環境的牌' },
  { name: 'current-news', text: 'SVWB 最近一次維護是什麼時候？具體改了哪些內容？' },
  { name: 'tempo-elf-existing-session', text: '來一套節奏妖', old: true, deckDelivery: true },
  { name: 'dragon-rotation-budget-regression', text: '下版本龍族退掉什麼牌', replay: true },
  { name: 'complete-rotation-list', text: '下版本全部退環境的牌，全部職業與中立都列出，不要只給重點', completeList: true },
  { name: 'official-terminology-existing-session', old: true, terminology: true,
    text: '請把以下 SVWB 英文術語逐一寫成官方繁中用語，照原順序列成 English＝繁中，每行一項，全部列完，不需解釋：' + terminology.entries.map(t => t.en).join('、') },
];
cases.push({ name: 'offline-cards-and-progress', old: true, cardCache: true,
  text: '請先用本機資料查卡名「群蟲惡兆」的卡效，並搜尋所有卡效含守護的精靈卡（含中立以外的精靈即可），列出前五張繁中名稱。查到第一張卡的資料時先更新一下進度，再繼續整理。這次只需已快取的資料，不用上網查最新版本。' });
cases.push({name:'strongest-three-multiple-sources',text:'能給出三套當前最強的牌組嗎',multiSource:true});
cases.push({name:'next-update-year-check',text:'下次新版本更新是幾時？',dateCheck:true});
const budgetCtx = new FakeContext();
const env = { ...process.env, ...config.vars, TURN_BUDGET_CENTS: process.env.SMOKE_TURN_CENTS || config.vars.TURN_BUDGET_CENTS,
  ANSWER_RESERVE_CENTS: '4', DAILY_BUDGET_CENTS: '100', BUDGET_MARGIN_CENTS: '0' };
const budget = new DailyBudget(budgetCtx, env); await budgetCtx.ready;
env.BUDGET = { getByName: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) };
for (const [index, item] of cases.entries()) {
  if (process.argv[2] ? !process.argv[2].split(',').map(Number).includes(index) : index > 2) continue;
  const replies = [], attachments = [], progress = [], finalIndexes = new Map();
  let discordSequence = 0;
  const ctx = new FakeContext(), conversation = new Conversation(ctx, env); await ctx.ready;
  let original, finalization = false, completionEvents = [], completionCost = 0;
  const createdSessions = new Set();
  let replay;
  if (item.replay) {
    const captured = JSON.parse(await readFile('.wrangler/dragon-rotation-failure.json', 'utf8'));
    const user = captured.events.find(e => e.type === 'user.message');
    const text = user.content.find(b => b.type === 'text').text;
    replay = { data: JSON.parse(text.slice(text.indexOf('\n{"discord_message_id"') + 1)), images: user.content.filter(b => b.type === 'image') };
    conversation.state.summary = replay.data.previous_conversation_summary;
  }
  globalThis.fetch = async (url, init) => {
    // All Discord operations are local captures: no test messages are posted.
    if (new URL(url).hostname === 'discord.com') {
      const messageId = init?.method === 'PATCH' ? new URL(url).pathname.split('/').at(-1) : `local-${++discordSequence}`;
      if (init?.method === 'PATCH' || String(url).endsWith('/messages')) {
        if (init.body instanceof FormData) {
          const payload = JSON.parse(init.body.get('payload_json'));
          replies.push(payload.content);
          for (const a of payload.attachments || []) {
            const file = init.body.get(`files[${a.id}]`);
            attachments.push({ ...a, size: file.size, type: file.type });
            await writeFile(`.wrangler/research-${index}-${a.filename}`, new Uint8Array(await file.arrayBuffer()));
          }
        } else {
          const content=JSON.parse(init.body).content;
          if (conversation.state.current?.phase !== 'settle') progress.push({method:init.method,id:messageId,content});
          else if(finalIndexes.has(messageId)) replies[finalIndexes.get(messageId)]=content;
          else { finalIndexes.set(messageId,replies.length); replies.push(content); }
        }
      }
      return Response.json({ id: messageId });
    }
    if (new URL(url).hostname === 'api.anthropic.com' && init?.method === 'DELETE' && conversation.state.current?.completionSessionId === new URL(url).pathname.split('/').at(-1)) {
      const id = conversation.state.current.completionSessionId;
      completionEvents = await eventsSince(env,id);
      completionCost = readCost(await claude(env,`/sessions/${id}`));
    }
    if (replay && new URL(url).hostname === 'api.anthropic.com' && String(url).endsWith('/events') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      const event = body.events.find(e => e.type === 'user.message' && e.content?.some(b => b.text?.includes('discord_message_id')));
      if (event) { event.content.push(...replay.images); init = { ...init, body: JSON.stringify(body) }; }
    }
    const response = await realFetch(url, init);
    if (response.ok && new URL(url).hostname === 'api.anthropic.com' && new URL(url).pathname === '/v1/sessions' && init?.method === 'POST') createdSessions.add((await response.clone().json()).id);
    if (response.ok && init?.method === 'DELETE') createdSessions.delete(new URL(url).pathname.split('/').at(-1));
    if (!response.ok && new URL(url).hostname === 'api.anthropic.com') {
      const error = await response.clone().json().catch(() => ({}));
      console.error(JSON.stringify({ status: response.status, type: error.error?.type, message: error.error?.message?.slice(0,800) }));
    }
    return response;
  };
  try {
    if (item.old) {
      original = await claude(env, '/sessions', 'POST', {
        agent: { type: 'agent', id: setup.agentId, version: setup.agentVersion - 1 }, environment_id: setup.environmentId,
        title: 'SVWB existing-session research test', budget: { type: 'limit', max_list_cost: { amount: '2', currency: 'USD' } },
      });
      conversation.state.sessionId = original.id;
      conversation.state.contextTokens = 0;
    }
    await conversation.fetch(new Request('https://conversation/message', { method: 'POST', body: JSON.stringify({
      id: `research-${index}-${Date.now()}`, authorId: 'test', authorName: '測試', channelId: 'local-only', text: item.text,
    }) }));
    for (let poll = 0; poll < 120; poll++) {
      await conversation.alarm();
      finalization ||= !!conversation.state.current?.finalizationAttempted;
      if (!conversation.state.current && !conversation.state.queue.length) break;
      if (poll === 119) throw Error('Timed out');
      await new Promise(r => setTimeout(r, 2000));
    }
    const id = conversation.state.sessionId;
    const session = await claude(env, `/sessions/${id}`), events = await eventsSince(env, id);
    const result = { case: item.name, progress, version: session.agent.version, reply: replies.join('\n'), costCents: readCost(session),
      sessionPreserved: !original || original.id === id, blocked: conversation.state.blocked || null,
      tools: events.filter(e => /tool_use$/.test(e.type)).map(e => ({ type: e.type, name: e.name, input: e.input })),
      finalization, completionCost, totalCostCents: readCost(session) + completionCost, chunks: replies.length, attachments,
    };
    await writeFile(`.wrangler/research-${index}.json`, JSON.stringify({ result, events, completionEvents }, null, 2));
    console.log(JSON.stringify(result));
    if (item.dateCheck) {
      if(result.blocked || /2026年?\s*10月\s*29日.{0,20}(?:推出|更新|登場|發售)/.test(result.reply) || /星期.{0,6}(?:有誤|誤植)/.test(result.reply)) throw Error('Old date was promoted to a future release');
    }
    if (item.multiSource) {
      if (!progress.some(p=>p.method==='POST') || !progress.some(p=>p.method==='PATCH')) throw Error('Natural research did not publish initial content and a later interim edit');
      if (progress.some(p=>/收到，我先看看/.test(p.content))) throw Error('Canned acknowledgement returned');
      const reads=events.filter(e=>e.type==='user.custom_tool_result').map(e=>JSON.parse(e.content[0].text)).filter(r=>r.status==='ok' && r.source && r.text);
      const hosts=[...new Set(reads.map(r=>new URL(r.source).hostname))];
      console.log(JSON.stringify({readSourceHosts:hosts}));
      if(/[\u3040-\u30ff]/.test(result.reply)) throw Error('Untranslated Japanese labels in recommendation');
      if(result.blocked || !hosts.includes('gamewith.jp') || !hosts.includes('game8.jp')) throw Error('Strongest-three answer did not read both independent guide sources');
      continue;
    }
    if (item.cardCache) {
      if (result.blocked || !result.reply.includes('群蟲惡兆') || !progress.some(p=>p.method==='POST')) throw Error('Card cache/progress flow failed');
      if (result.tools.some(t=>['web_search','web_fetch','read_svwb_source'].includes(t.name))) throw Error('Snapshot lookup should need no web tools');
      const outputs=events.filter(e=>e.type==='user.custom_tool_result').map(e=>JSON.parse(e.content[0].text));
      if(!outputs.some(o=>o.verification==='official_snapshot' || o.cards?.some(c=>c.verification==='official_snapshot'))) throw Error('Snapshot evidence missing');
      continue;
    }
    if (item.deckDelivery && (!attachments.some(a => a.type === 'image/png' && a.size > 1024) ||
      !/牌組代碼：`[a-z0-9]{4}`/i.test(result.reply))) throw Error('Verified deck code or PNG attachment missing');
    if (item.deckDelivery) {
      const links = [...result.reply.matchAll(/https:\/\/shadowverse-wb\.com\/[^\s<>\])]+/g)].filter(match => deckImageUrl(match[0]));
      if (links.length !== 1 || !links[0][0].includes('/cht/')) throw Error('Deck link must appear once in Chinese');
      if (/我先(?:把|當)|以下是.{0,10}推論|已驗證.{0,5}指南|占.{0,15}樣本|全服使用率|[\u3040-\u30ff]|增幅\s*4/.test(result.reply)) throw Error('Reviewed wording, untranslated names, or incorrect terminology regressed');
    }
    if (item.terminology) {
      const lines = result.reply.split('\n');
      const missing = terminology.entries.filter(t => !lines.some(line => line.includes(t.en) &&
        (line.includes(t.cht) || t.cht === '+1/+2' && line.includes('+X/+Y'))));
      console.log(JSON.stringify({ officialTerms: terminology.entries.length, missing: missing.map(t => t.cht) }));
      if (missing.length || result.blocked) throw Error('Official terminology mismatch');
      continue;
    }
    if (item.completeList) {
      const { cardCatalog } = await import('../src/chat/cards.js');
      const expected = await cardCatalog({pack_id:10004},0,realFetch,{limit:120});
      const missing = expected.cards.filter(c=>!result.reply.includes(c.name));
      console.log(JSON.stringify({ officialTotal:expected.total, expectedNames:expected.cards.length, missing:missing.map(c=>c.name) }));
      if (expected.nextOffset !== null || missing.length) throw Error('Complete list omitted official card names');
    }
    if (item.replay && (!/蒼空六龍/.test(result.reply) || !/維爾納斯/.test(result.reply) || !/佐伊/.test(result.reply) ||
      !events.some(e => e.type === 'agent.custom_tool_use' && e.name === 'query_svwb_data' && e.input?.resource === 'catalog'))) throw Error('Rotation answer did not identify the relevant official card list');
    if (result.blocked || result.reply.length < 100 || !result.reply.includes('https://') || needsChineseRewrite(result.reply, item.text) ||
      /請(?:你)?自行|建議你.{0,5}(?:打開|查看)|請提供牌組代碼|整理沒有完成/.test(result.reply) ||
      !events.some(e => e.type === 'agent.custom_tool_use' && e.name === 'read_svwb_source')) throw Error(`${item.name}: evidence or concrete answer missing`);
  } catch (error) { console.error(error.status ? `HTTP ${error.status}` : error.message); process.exitCode = 1; }
  finally {
    for (const id of [conversation.state.sessionId, original?.id, ...createdSessions, ...(conversation.state.retiredSessions || [])].filter((v,i,a)=>v&&a.indexOf(v)===i))
      await claude(env, `/sessions/${id}`, 'DELETE').catch(() => console.error('Test session cleanup failed'));
    globalThis.fetch = realFetch;
  }
}
