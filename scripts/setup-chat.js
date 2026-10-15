import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { claude, discord } from '../src/chat/api.js';
import { FUN_TOOLS, FUN_GUIDANCE } from '../src/chat/fun.js';
import { RESPONSE_STYLE } from '../src/chat/style.js';
import { TERMINOLOGY_GUIDANCE } from '../src/chat/terminology.js';
import { MEMORY_TOOLS, MEMORY_GUIDANCE } from '../src/chat/personal-memory.js';

async function main() {
  for (const name of ['ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN']) if (!process.env[name]) throw new Error(`Missing ${name}`);
  const app = await discord(process.env, '/oauth2/applications/@me');
  if (!(app.flags & ((1 << 18) | (1 << 19)))) throw new Error('Enable Message Content Intent in Discord Developer Portal first');
  const agentSpec = JSON.parse(await readFile(new URL('../claude/agent.json', import.meta.url), 'utf8'));
  agentSpec.system = await readFile(new URL('../claude/system-prompt.md', import.meta.url), 'utf8');
  agentSpec.tools = [...agentSpec.tools, ...FUN_TOOLS, ...MEMORY_TOOLS];
  agentSpec.system += '\n\n' + FUN_GUIDANCE;
  agentSpec.system += '\n\n' + MEMORY_GUIDANCE;
  agentSpec.system += '\n\n' + RESPONSE_STYLE + TERMINOLOGY_GUIDANCE;
  const sources = JSON.parse(await readFile(new URL('../claude/sources.json', import.meta.url), 'utf8'));
  agentSpec.system += '\n\n## 優先查閱來源\n' + sources.map(s => `- ${s.name}：${s.url}\n  用途：${s.use_for}`).join('\n');
  if (agentSpec.model?.id !== 'claude-haiku-5-5' || agentSpec.model?.effort?.type !== 'high') throw new Error('This bot must use Haiku 5.5 with high effort');
  let setup = {};
  try { setup = JSON.parse(await readFile('.chat-setup.json', 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const persist = () => writeFile('.chat-setup.json', JSON.stringify(setup, null, 2) + '\n', { mode: 0o600 });
  if (!setup.agentId) {
    const agent = await claude(process.env, '/agents', 'POST', agentSpec);
    setup.agentId = agent.id;
    setup.agentVersion = agent.version || 1;
    await persist();
  } else if (process.argv.includes('--update-agent')) {
    const agent = await claude(process.env, `/agents/${setup.agentId}`, 'POST', agentSpec);
    setup.agentVersion = agent.version;
    await persist();
  }
  const agent = await claude(process.env, `/agents/${setup.agentId}`);
  if ((agent.model?.id || agent.model) !== 'claude-haiku-5-5') throw new Error('Existing agent is not Haiku 5.5');
  if (!setup.environmentId) {
    const environment = await claude(process.env, '/environments', 'POST', {
      name: 'svwb-discord-chat-env',
      config: { type: 'cloud', networking: { type: 'unrestricted' } },
    });
    setup.environmentId = environment.id;
    await persist();
  }
  const config = JSON.parse(await readFile('wrangler.chat.json', 'utf8'));
  config.vars.CLAUDE_AGENT_ID = setup.agentId;
  config.vars.CLAUDE_AGENT_VERSION = String(setup.agentVersion);
  config.vars.CLAUDE_ENVIRONMENT_ID = setup.environmentId;
  await writeFile('wrangler.chat.local.json', JSON.stringify(config, null, 2) + '\n');
  let secrets = {};
  try { secrets = JSON.parse(await readFile('.chat-secrets.json', 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await writeFile('.chat-secrets.json', JSON.stringify({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    CHAT_ADMIN_TOKEN: secrets.CHAT_ADMIN_TOKEN || randomBytes(32).toString('hex'),
  }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ bot: app.name, agentId: setup.agentId, agentVersion: setup.agentVersion,
    environmentId: setup.environmentId, model: 'claude-haiku-5-5', effort: agent.model.effort.type, dailyBudgetUSD: 2, timezone: 'Asia/Tokyo' }));
}

main().catch(error => {
  console.error(error.status ? `Setup failed: HTTP ${error.status}` : error.message);
  process.exitCode = 1;
});
