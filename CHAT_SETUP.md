# Discord conversations with Claude Managed Agents

This companion Worker adds mention and thread chat to **電競魅魔**. The existing
`svwb-deck-bot` interaction endpoint and slash commands are not redeployed.
The old GitHub Worker source is older than the live deck bot; do not use its
original `wrangler.toml` to deploy this feature.

## Behavior

- In 納薩利克地下大造咖 and backup, mention the bot in a channel to chat. Each person's
  channel conversation has separate memory, although replies remain visible there.
- Mention the bot once inside a thread. Everyone in that thread can then chat
  without mentioning it again. The thread shares one conversation history.
- Thread participation expires after 24 hours without an accepted message.
- The person who activated a thread can send `@電競魅魔 stop` to stop automatic
  replies, or `@電競魅魔 reset` to delete its Claude history and start fresh.
  Stopping participation allows already queued replies to finish.
- Bots, webhooks, DMs, other servers, and unrelated channel messages are ignored.
- Adding a mention by editing an unhandled message also starts a reply. Editing
  a message already accepted by the bot does not generate a duplicate response;
  send a new message for corrections to an answered question.
- Attachment uploads are not sent to Claude in this version. Paste relevant text.
- Web search/fetch are available. Private saved decks and deck database tools are
  not connected to Claude; the existing slash commands continue to handle them.
- Natural requests such as `@電競魅魔 幫我看看這副牌：y8hf` automatically look up
  up to two four-character deck codes through the official Portal in Traditional
  Chinese. The model receives card counts, costs, base/evolved effects and a source
  link. Follow-up turns retain that deck. Failed lookups ask for a valid code or
  pasted list; codes are never interpreted as guessed deck contents.

## Model and budget

The dedicated agent uses **claude-haiku-5-5**, pinned to a specific agent version.
No subagents, advisors, shell, filesystem, or MCP tools are enabled.

One global Durable Object enforces a **$2/day AI list-cost budget**, resetting at
**00:00 Asia/Tokyo**. Each turn reserves 20 cents plus a two-cent rounding margin
before starting, across all conversations in both servers. The unused reservation is reclaimed
only after the session becomes idle and reports its cost. Uncertain outcomes keep
their reservation; reset charges it rather than refunding it. Open reservations
carry across midnight, and a turn spanning midnight is conservatively charged to
both days. Ten cents of the daily limit is held back as a safety margin.

Anthropic enforces session budgets between model requests: an in-flight request
and its tools can finish above the cap. The application stops admitting new work
conservatively, but this is **not an exact billing guarantee**. The ledger uses
reported cumulative list cost (tokens, web search, and agent runtime) with an extra
cent per completed turn to cover rounding. Cloudflare hosting charges are separate.
The outbound Discord WebSocket keeps its Durable Object active and cannot use
WebSocket hibernation. The 100-message/day and five-message/minute/user limits
provide additional protection.

## Setup and deployment

Requires Node 22+, Wrangler, Cloudflare Workers/Durable Objects access, a Claude API
key, and the existing Discord application's bot token. Enable **Message Content
Intent** in Discord Developer Portal. Bot permissions: View Channels, Read Message
History, Send Messages, and Send Messages in Threads. Private threads must include
the bot. Keep the existing Interactions Endpoint URL unchanged.

1. Create `.env.txt` locally with `ANTHROPIC_API_KEY` and `DISCORD_BOT_TOKEN`.
   This file and generated secret files are Git-ignored. Never commit them.
2. Run `npm run chat:setup`. It creates the dedicated agent and environment,
   generates `wrangler.chat.local.json`, and writes `.chat-secrets.json` for direct
   secret upload. Re-running reuses `.chat-setup.json` rather than creating copies.
3. Run `npm test` and `wrangler deploy --dry-run --config wrangler.chat.local.json`.
4. Run `wrangler login` if needed, then `npm run chat:deploy`.
5. Upload directly from disk with
   `wrangler secret bulk .chat-secrets.json --config wrangler.chat.local.json`.
6. Run `npm run chat:start`, then `npm run chat:status`. Expect `connected: true`.

No process on the local PC needs to stay running after deployment.

## Edit the prompt

Edit `claude/system-prompt.md` for the SVWB-only scope, Taiwanese Traditional Chinese
voice, terminology, sourcing rules, and conversational style. `claude/agent.json`
sets the fixed Haiku model and enabled tools.

Apply an intentional prompt change with
`node --env-file=.env.txt scripts/setup-chat.js --update-agent`, then redeploy using
`npm run chat:deploy`. The setup script stores and pins the new agent version.
Existing conversations keep their original prompt; their starter can use
`@電競魅魔 reset` to apply the new version to a fresh conversation.

## Operations

- `npm run chat:status`: connection state, missing configuration, daily budget.
- `npm run chat:stop`: stop the Gateway and new incoming messages. In-flight
  conversations may finish within their existing budget reservations.
- `npm run chat:start`: reconnect after an intentional stop or a fatal error.
- `node --env-file=.env.txt scripts/smoke-managed-agent.js`: a separate bounded
  API test, with no Discord messages. Its small API charge is outside the deployed
  bot's ledger. The script deletes its own test session afterward.

Gateway reconnects use persisted Discord session/sequence state. Incoming messages
are durably queued and deduplicated. Each conversation serializes turns and polls
Claude using alarms; it does not rely on a short-lived request's `waitUntil`.
Ambiguous message submissions are reconciled against Claude's event history before
continuing. Discord delivery uses stable nonces to suppress immediate duplicates;
Discord's nonce deduplication window is finite, so a long outage can still cause a
repeated partial reply. Credentials and message text are excluded from error logs.

Cloudflare stores the conversation queue and routing metadata. Claude stores each
conversation's transcript. A conversation reset deletes its Claude session.

References:
- https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- https://platform.claude.com/docs/en/managed-agents/budgets
- https://docs.discord.com/developers/events/gateway
- https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/
