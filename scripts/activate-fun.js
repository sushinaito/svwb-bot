// Uses the existing bot token locally; it is never uploaded to the new Worker.
import fs from 'node:fs/promises';
import { commands } from '../src/fun/commands.js';
const config = JSON.parse(await fs.readFile('wrangler.fun.json', 'utf8'));
const secrets = JSON.parse(await fs.readFile(process.env.CHAT_SECRETS_FILE || '.chat-secrets.json', 'utf8'));
const base = process.env.FUN_URL || 'https://svwb-fun-bot.svwb-deckhelper.workers.dev';
const backupPath = '.wrangler/fun/activation.json';
async function discord(path, method = 'GET', body) {
  const r = await fetch('https://discord.com/api/v10' + path, { method, headers: { Authorization: `Bot ${secrets.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`Discord ${method} ${path}: HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}
const app = await discord('/applications/@me');
if (app.id !== config.vars.DISCORD_APPLICATION_ID || app.verify_key !== config.vars.DISCORD_PUBLIC_KEY) throw Error('Wrong application or signature key');
const endpoint = base + '/interactions';
if (process.argv.includes('--rollback')) {
  const saved = JSON.parse(await fs.readFile(backupPath, 'utf8'));
  if (app.interactions_endpoint_url !== endpoint) throw Error('Endpoint changed elsewhere; refusing to overwrite it');
  await discord('/applications/@me', 'PATCH', { interactions_endpoint_url: saved.previousEndpoint });
  for (const c of saved.created) await discord(`/applications/${app.id}/guilds/${c.guild}/commands/${c.id}`, 'DELETE');
  console.log('Previous endpoint restored; commands created by this activation removed.');
} else {
  const health = await fetch(base + '/health').then(r => r.json());
  if (!health.ok || health.service !== 'svwb-fun') throw Error('New endpoint is not healthy');
  if (![config.vars.LEGACY_INTERACTIONS_URL, endpoint].includes(app.interactions_endpoint_url?.replace(/\/$/, ''))) throw Error('Existing endpoint differs from the configured legacy route');
  const globalBefore = await discord(`/applications/${app.id}/commands`);
  const guilds = config.vars.ALLOWED_GUILD_IDS.split(',');
  let saved;
  try { saved = JSON.parse(await fs.readFile(backupPath, 'utf8')); } catch {}
  saved ||= { previousEndpoint: app.interactions_endpoint_url, created: [], globalCommands: globalBefore.map(c => ({ id: c.id, name: c.name, version: c.version })) };
  await fs.mkdir('.wrangler/fun', { recursive: true });
  await fs.writeFile(backupPath, JSON.stringify(saved, null, 2));
  for (const guild of guilds) {
    const existing = await discord(`/applications/${app.id}/guilds/${guild}/commands`);
    for (const c of existing) if (commands.some(n => n.name === c.name) && !saved.created.some(n => n.id === c.id && n.guild === guild)) throw Error(`Existing /${c.name} in ${guild} is not owned by this setup`);
  }
  await discord('/applications/@me', 'PATCH', { interactions_endpoint_url: endpoint });
  try {
    for (const guild of guilds) for (const command of commands) {
      const { contexts, integration_types, ...definition } = command;
      const c = await discord(`/applications/${app.id}/guilds/${guild}/commands`, 'POST', definition);
      if (!saved.created.some(x => x.id === c.id && x.guild === guild)) saved.created.push({ guild, id: c.id, name: c.name });
      await fs.writeFile(backupPath, JSON.stringify(saved, null, 2));
    }
    const globalAfter = await discord(`/applications/${app.id}/commands`);
    if (JSON.stringify(globalBefore) !== JSON.stringify(globalAfter)) throw Error('Global commands changed unexpectedly');
    const current = await discord('/applications/@me');
    if (current.interactions_endpoint_url !== endpoint) throw Error('Endpoint activation did not persist');
    console.log(JSON.stringify({ endpoint, guilds, newCommands: commands.map(c => c.name), preservedGlobalCommands: globalAfter.map(c => c.name) }, null, 2));
  } catch (error) {
    await discord('/applications/@me', 'PATCH', { interactions_endpoint_url: saved.previousEndpoint });
    // Keep recorded IDs so a later run can safely resume or remove only our commands.
    console.error('Activation failed; previous endpoint restored.'); throw error;
  }
}
