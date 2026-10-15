import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { jstDay } from '../src/chat/budget.js';

const action = process.argv[2] || 'status';
if (!['status', 'start', 'stop', 'source-health', 'budget-reset'].includes(action)) throw new Error('Use status, start, stop, source-health, or budget-reset');
const secrets = JSON.parse(await readFile('.chat-secrets.json', 'utf8'));
const base = process.env.CHAT_URL || 'https://svwb-chat-bot.svwb-deckhelper.workers.dev';
const response = await fetch(`${base}/admin/${action}`, {
  method: ['status', 'source-health'].includes(action) ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${secrets.CHAT_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  ...(action === 'budget-reset' ? { body: JSON.stringify({ day: jstDay(), requestId: process.argv[3] || randomUUID() }) } : {}),
});
if (!response.ok) throw new Error(`Admin request HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
