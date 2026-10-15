import { readFile } from 'node:fs/promises';
import { FUN_VERSION, FUN_TOOLS } from '../src/chat/fun.js';
import { MEMORY_TOOLS, PERSONAL_MEMORY_VERSION } from '../src/chat/personal-memory.js';
const secrets = JSON.parse(await readFile('.chat-secrets.json', 'utf8'));
const config = JSON.parse(await readFile('wrangler.chat.local.json', 'utf8'));
const base = process.env.CHAT_URL || 'https://svwb-chat-bot.svwb-deckhelper.workers.dev';
const expected = ['read_svwb_source', 'query_svwb_data', 'report_svwb_progress', ...FUN_TOOLS.map(t => t.name), ...MEMORY_TOOLS.map(t => t.name)];
let previous;
for (let attempt = 0; attempt < 16; attempt++) {
  const response = await fetch(`${base}/admin/status`, { headers: { Authorization: `Bearer ${secrets.CHAT_ADMIN_TOKEN}` }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`Status HTTP ${response.status}`);
  const status = await response.json(), runtime = status.conversationRuntime || {};
  const check = { enabled: status.enabled, connected: status.connected, agentVersion: status.agentVersion,
    gatewayFunVersion: status.naturalChatActionsVersion || null, conversationFunVersion: runtime.funVersion || null,
    catalogBatching: !!(status.catalogBatchingSupported && runtime.catalogBatching),
    sharedReplyContextVersion:status.sharedReplyContextVersion===1&&runtime.sharedReplyContextVersion===1?1:0,
    personalMemoryVersion:status.personalMemoryVersion===PERSONAL_MEMORY_VERSION&&runtime.personalMemoryVersion===PERSONAL_MEMORY_VERSION?PERSONAL_MEMORY_VERSION:0,
    personalMemoryStorage:runtime.personalMemoryStorage,
    personalMemoryAuthenticated:!!runtime.personalMemoryAuthenticated,
    cardDatabase: runtime.cardDatabase, progressReplyVersion: runtime.progressReplyVersion,
    deckDatabase: runtime.deckDatabase, deckCacheVersion: runtime.deckCacheVersion,cardCompletionVersion:runtime.cardCompletionVersion,
    rendererAuthenticated: !!(status.cardRendererConfigured && runtime.rendererAuthenticated),
    missingTools: expected.filter(name => !runtime.tools?.includes(name)), error: status.lastError || null };
  const serialized = JSON.stringify(check);
  if (serialized !== previous) console.log(serialized);
  previous = serialized;
  if (check.enabled && check.connected && check.agentVersion === Number(config.vars.CLAUDE_AGENT_VERSION) &&
      check.gatewayFunVersion === FUN_VERSION && check.conversationFunVersion === FUN_VERSION &&
      check.cardDatabase?.available && check.progressReplyVersion === 2 && check.deckDatabase?.available && check.deckCacheVersion === 2 && check.deckDatabase.storage === 'cloud_durable_object' &&
      check.sharedReplyContextVersion===1 && check.personalMemoryVersion===PERSONAL_MEMORY_VERSION && check.personalMemoryAuthenticated && check.personalMemoryStorage==='managed_agents_memory_store' && check.cardCompletionVersion===1 && check.catalogBatching && check.rendererAuthenticated && !check.missingTools.length && !check.error) {
    console.log('Verified: research, natural-chat actions, authenticated card rendering and per-user Managed Agents memory are live.');
    process.exit(0);
  }
  if (attempt < 15) await new Promise(resolve => setTimeout(resolve, 15000));
}
throw Error('Combined deployment has not reached every runtime; do not report it ready.');
