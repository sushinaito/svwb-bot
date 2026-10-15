import { readFile } from 'node:fs/promises';

const action = process.argv[2] || 'status';
if (!['status', 'start', 'stop'].includes(action)) throw new Error('Use status, start, or stop');
const secrets = JSON.parse(await readFile('.chat-secrets.json', 'utf8'));
const base = process.env.CHAT_URL || 'https://svwb-chat-bot.svwb-deckhelper.workers.dev';
const response = await fetch(`${base}/admin/${action}`, {
  method: action === 'status' ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${secrets.CHAT_ADMIN_TOKEN}` },
});
if (!response.ok) throw new Error(`Admin request HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
