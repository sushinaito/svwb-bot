# Discord conversations with Claude Managed Agents

This companion Worker adds mention and thread chat to **電競魅魔**. The existing
`svwb-deck-bot` interaction endpoint and slash commands are not redeployed.
The old GitHub Worker source is older than the live deck bot; do not use its
original `wrangler.toml` to deploy this feature.

## Behavior

- In 納薩利克地下大造咖 and backup, mention the bot in a channel to chat. Each person's
  channel conversation has separate memory, although replies remain visible there.
- Discord's Reply action on one of her messages also works without mentioning her,
  even with the reply notification turned off. The quoted bot message is included
  as context; another person's separate conversation history is not imported.
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
- Image uploads are sent to Claude as image content, including attachments in the
  explicitly replied-to message. In normal channels, attach images while mentioning
  the bot, or reply to her image message. To discuss another person's image, reply
  to that message and mention her. Active threads also accept image-only messages.
  Limits: two images per request, 5 MB and 8000 pixels per side per image; PNG,
  JPEG, WebP and GIF (first frame). Other files and arbitrary pasted image URLs
  are not loaded. Oversized, expired, deleted or invalid images produce an explicit
  failure report while usable images and text can still be answered.
- Only attachment metadata is queued locally. Image bytes are fetched from the
  Discord attachment CDN immediately before sending to Claude, within the existing
  turn allowance. Expired links are refreshed from the exact referenced message.
  Images remain in the Claude conversation for follow-ups; reset deletes its
  sessions. Summary rollover preserves observations, not original image pixels.
  Incoming image tokens count toward compaction; a new session is also created
  before exceeding 16 images to avoid upstream many-image limits.
- Recommended decks with official Portal hash links include up to two Traditional
  Chinese deck pictures as file attachments. URL previews are suppressed; source
  links stay clickable. Image failures leave the text answer available. The bot
  needs Attach Files permission. Deck-code-only links without a hash are currently
  text links.
- Web search/fetch are available. Private saved decks and deck database tools are
  not connected to Claude; the existing slash commands continue to handle them.
- Broad questions about popular decks or the current meta load all seven classes
  without requiring a class name. Cross-class percentages use all sampled builds;
  within-class percentages keep their own denominator. Competition questions also
  load the latest listed tournament within the source's date window, filtering by
  organizer when named. Tournament percentages include unclassified deck slots in
  the denominator. Missing tournament data does not discard the community sample;
  neither dataset claims to measure global ranked-ladder usage.
- Deck discovery loads current source data without requiring exact phrases such as
  “latest” or a class name. Current-version recommendations also receive the site's
  tier list, clearly separated from sample popularity and win-rate claims. A failed
  optional tier lookup does not discard other valid data.
- Natural requests such as `@電競魅魔 幫我看看這副牌：y8hf` automatically look up
  up to two four-character deck codes through the official Portal in Traditional
  Chinese. The model receives card counts, costs, base/evolved effects and a source
  link. Follow-up turns retain that deck. Failed lookups ask for a valid code or
  pasted list; codes are never interpreted as guessed deck contents.

## Model and budget

The dedicated agent uses **claude-haiku-5-5** with **high effort** and standard
speed, pinned to a specific agent version. Effort is fixed for each session:
use `@電競魅魔 reset` once in an existing conversation to start using the new
effort setting (this clears that conversation's history).
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

Edit `claude/sources.json` to set preferred deck, card, update, and tournament
sources, with a purpose for each URL. Setup includes it in the agent prompt and
the Worker supplies it on every turn, so existing sessions receive source updates
after redeployment. Add specific community organizers only after verifying their
pages; the official event index is not a substitute for an event's participant list.
The user-selected primary community sources are `https://svwbmeta.com/deck`
for deck information and `https://x.com/scl_shadowverse` for SCL announcements.
X can reject unauthenticated reads and SVWB Meta uses dynamic content; the prompt
requires explicit uncertainty and public search/event-link fallbacks.

Apply an intentional prompt change with
`node --env-file=.env.txt scripts/setup-chat.js --update-agent`, then redeploy using
`npm run chat:deploy`. The setup script stores and pins the new agent version.
Existing conversations keep their original prompt; their starter can use
`@電競魅魔 reset` to apply the new version to a fresh conversation.
Every turn also includes a short language reminder, including existing sessions:
summarize foreign-language search material in Taiwanese Traditional Chinese and
include source links. Necessary proper names may remain in their original language.

## Operations

Conversation context is isolated by guild/channel/user in normal channels, where
each message needs a bot mention. An opted-in thread shares its conversation with
participants and accepts follow-ups without mentions for 24 hours since activity.
Only messages accepted after opt-in enter context; the bot does not backfill the
channel's history or read unrelated untagged chatter into its normal conversations.

Before the next message, the bot summarizes and starts a successor session when
the latest model-request context plus incoming data approaches 80,000 tokens, or
the previous accepted turn was more than 30 minutes ago. It includes cache reads,
cache writes and the last output; cumulative session token usage is not a context
size. Incoming UTF-8 byte length is a conservative estimate. An old session with
no local counter bootstraps from the latest model request event. The configurable
CONTEXT_COMPACT_TOKENS value is clamped to 50K–90K (default 80K).

Managed Agents exposes no configurable compaction trigger in its public agent or
session schema, so this is application-level summary rollover between turns. It
cannot prevent a large tool result within a turn from crossing 100K. Summaries may
lose detail. Summary and reply share one reservation, and the successor session's
cap is reduced by summary spend; both sessions are accounted with rounding guards.
No model calls run merely because the conversation is idle. Old idle sessions
remain available as original records; reset deletes them and the saved summary.

Bot user mentions and its own Discord-managed bot role both trigger chat and
`reset`. Other roles do not. If `reset` succeeds the bot explicitly confirms
the history was cleared; a missed reset does not change the pinned agent version.

Class-specific deck/meta questions also read SVWB Meta's public manifest and
versioned JSON, so answers do not depend on Claude being able to render its page.
The adapter supplies the 14-day sample window, Traditional Chinese archetype/card
names and at most two example lists. Sample shares are not win rates. Fetches are
bounded and failures are explicit; it does not scrape private or logged-in data.
Cloudflare fetches use `redirect: 'manual'` and reject non-success statuses;
Workers do not support Node's `redirect: 'error'` option. Run
`node scripts/chat-admin.js source-health` after deployment to verify the actual
edge runtime can retrieve the manifest, summary, labels, cards and example lists.
This authenticated check does not call Claude or post to Discord.

Answers are held until the turn finishes. A heuristic detects long English
sentences or substantial Japanese kana in a default-Chinese reply and requests
one rewrite within the original turn budget. If it still fails, a Chinese notice
is sent instead of the foreign-language draft. Explicit requests for English or
Japanese bypass the check; this is a guard, not a guarantee of perfect translation.

- `npm run chat:status`: connection state, missing configuration, daily budget.
- `npm run chat:stop`: stop the Gateway and new incoming messages. In-flight
  conversations may finish within their existing budget reservations.
- `npm run chat:start`: reconnect after an intentional stop or a fatal error.
- `node --env-file=.env.txt scripts/smoke-managed-agent.js`: a separate bounded
  API test, with no Discord messages. Its small API charge is outside the deployed
  bot's ledger. The script deletes its own test session afterward.
- `node --env-file=.env.txt scripts/smoke-language.js [agent-version]`: bounded
  live search/language regression test; checks for web search, Chinese output,
  and long untranslated English passages. Also deletes its test
  session and incurs a small API charge outside the bot ledger.
- `node --env-file=.env.txt scripts/smoke-meta.js [agent-version]`: checks live
  Dragon data and a Chinese answer using the supplied data, with a 20-cent session
  cap. Deletes the test session; its usage is outside the bot ledger.
- `node --env-file=.env.txt scripts/smoke-compaction.js`: runs the real conversation
  state machine with disposable Claude sessions and local-only Discord delivery,
  forces the context boundary without buying filler tokens, and verifies that a
  budget and class preference survive summary rollover. Deletes test sessions.

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
- General SVWB questions use a shared research workflow rather than a list of
  question-specific answers. The agent can call `read_svwb_source` for actual
  official/GameWith/Game8/SVWB Meta/Shadowverse Wins page text, headings, dates, links and subsequent
  ranges, and `query_svwb_data` for official cards, deck codes or meta data. These
  are bounded public read operations; other sites remain available through the
  managed web tools. Source text is untrusted data. The guide reader removes global
  navigation where possible and retains image alt labels used by card tables.
  Existing idle sessions receive these tools without losing their history.
  Custom tool results are retried by their idempotent event ID; only small markers
  are stored in the conversation. At most eight external data/page reads and 24 local snapshot/glossary reads run per turn.
  Search-only drafts receive one source-reading continuation when budget permits.
- `ANSWER_RESERVE_CENTS=4` reserves part of the existing 20-cent turn allowance
  for the final answer. A soft threshold interrupts research before admitting
  another costly model request. A temporary session uses the same pinned model,
  no tools, and bounded plain evidence to complete the answer, without inherited
  web citation instructions that can produce untranslated quotations. Its cap
  comes from the remaining turn allowance; both sessions' reported costs and
  rounding margins are charged to the same reservation. Provider enforcement is
  between requests, so a final request can still overshoot the cap. Temporary
  sessions are deleted after delivery; the original conversation is retained and
  receives the completed answer as context on its next turn. Japanese names are distinguished
  from sustained untranslated prose, so a mostly Chinese answer is not suppressed
  just because it contains several card or expansion names.
  `node --env-file=.env.txt scripts/smoke-research.js [0,1,2,3]` runs bounded live
  tests through the actual conversation state machine, captures Discord sends
  locally, and deletes test sessions. Tests incur provider charges outside the
  deployed daily ledger. Cases cover rules with old-session migration, game
  systems, rotation, current news, a tempo-elf deck request (case 4), the captured
  Dragon rotation failure (case 5), and a complete rotation list (case 6). The last
  case compares every returned name against the complete official pack catalog.
  Results are saved only under `.wrangler/`.
- Strategy questions (mulligans, opening hands, matchups and play patterns) prefer
  GameWith's SVWB guides, with Game8 as an additional research source. Named
  archetypes load their own current sample deck and Japanese/Traditional Chinese
  card-name mappings, including less popular archetypes. Applicable reply follow-ups
  can recover the archetype from the quoted bot message.
  The Worker discovers matching GameWith article links from its public index and
  directly reads the requested article sections, with format/title validation,
  update dates, 2 MiB response limits and a five-minute cache. It sends only relevant
  text to the model. No article IDs or fixed mulligan advice are hardcoded.
  If direct reading fails or the needed section is missing, the model continues
  web search/fetch instead of asking the user to read the page. Guidance requires
  concrete sourced conclusions, uncertainty scoped to actual gaps, and a clear
  distinction between guide recommendations and inference. A disposable live check
  is available as `node --env-file=.env.txt scripts/smoke-strategy.js [agent-version]`.
- An explicit owner-requested quota reset can be performed with
  `node scripts/chat-admin.js budget-reset [unique-request-id]`. This authenticated
  POST resets today's accounted allowance only, preserving open reservations,
  turn deduplication, conversation memory and the configured cap. Reusing the same
  request ID on the same JST day is idempotent. Reset history records the forgiven
  amount; the reset does not undo charges already incurred at the AI provider.
- Official Traditional Chinese card data is a private, bundled snapshot at
  `data/official-cards-cht.json`. Run `npm run cards:cache` once before deploying;
  an existing complete snapshot is reused without network requests. The downloader
  reads the public unfiltered catalog sequentially with a 1.5-second delay, validates
  page counts and IDs, stops on errors/rate limits, and atomically replaces the
  snapshot only after completion. There is no scheduled refresh. Deliberate updates
  use `npm run cards:cache -- --refresh`, followed by review and deployment.
  The initial download contains 811 listed cards plus 93 related tokens. It stores
  names, effects, stats, CV/illustrator and provenance, without artwork or flavor text.
  A one-time SVWB Meta name-index read adds Japanese/English aliases by exact card ID,
  with separate source/date metadata; official Chinese names and effects remain authoritative.
  Existing complete downloads and aliases are reused without refetching.
  The snapshot and scratch responses are gitignored; do not publish them as a public
  dataset. A one-time download reduces load but does not itself confer copyright
  permission; consult the official site's terms before redistribution.
- `cards` resolves Chinese names, exact IDs and official URLs from this snapshot,
  including tokens and the downloaded English/Japanese aliases. Explicit cached
  tool queries cannot silently fall back to the network; unmatched aliases require
  separate research or fresh=true. Automatic enrichment can still consult the
  public multilingual index for an unknown name (cached for five minutes). Pronoun follow-ups can use quoted or recent card
  IDs; ambiguity remains explicit. `catalog` searches literal name/effect keywords
  with `query` (space-separated AND) and `search_in=names|effects|all`, filters class/pack/rarity/cost, and paginates
  with `offset`, `limit`, `total` and `nextOffset`. `include_tokens=true` includes
  related tokens; `include_effects=true` returns full effects for up to 30 cards;
  compact pages allow 120 cards. `view=packs` returns the saved pack directory.
  Results carry `verification=official_snapshot` and `fetchedAt`. Rotation flags
  reflect the snapshot date; other formats use live filtering. Explicit `fresh=true`
  bypasses the cache for current eligibility, balance updates or new cards. Live
  catalog searches cannot combine free-text queries or token inclusion; omit these
  options and filter using the endpoint's supported fields. Future eligibility still
  requires sourced format rules and announcements.
  Only relevant matches and metadata go into model context, never the whole database.
  The package's default Node import uses an empty fixture so a clean checkout can run
  tests; Wrangler aliases the module to the private snapshot. `chat:deploy` validates
  that snapshot first. Offline integration verification uses
  `node --conditions=card-cache scripts/smoke-card-cache.js`.
- `claude/packs.json` stores nine historical pack records: official IDs, names,
  card counts, Japanese/English labels and full ISO release dates with per-field
  provenance. The user-provided community timeline supplies dates, with official
  corroboration retained where checked; unverified dates are explicitly marked
  community_reported. Basic cards are a separate set. Game8 directory conflicts
  are recorded instead of copied as facts. `query_svwb_data(resource=packs)` reads
  this file offline; query by name, ID, year or 第4彈, or omit query for all records.
  `catalog(view=packs)` also enriches official IDs with historical details. Refresh
  manually from each cited source when releases change. Never infer that an
  unlisted future pack has not been announced.
- Current strength comparisons and multiple strongest-deck recommendations read
  independent recent sources, prioritizing GameWith and Game8 alongside Meta and
  relevant tournament/build evidence. Preloaded Meta data is not proof of consensus.
  Final evidence retains source differences and known Chinese card/archetype labels.
  The source reader returns publication/modification dates, explicit years, and
  yearless weekday conflicts; a recent page update cannot make an old event current.
  Completed research answers are passed to the editor so correct chronology and
  uncertainty survive rewriting. Editing does not grant permission to invent dates
  or replace a checked year with an ambiguous old table. Bounded live cases 9 and 10
  cover the user's strongest-three and next-update questions.
- Each accepted chat request immediately posts a short acknowledgement before
  research, persisting its Discord message ID. The optional `report_svwb_progress`
  tool edits that same message with a useful evidence-based interim finding. Updates
  are coalesced, at least 15 seconds apart, with at most six interim edits per turn.
  Raw agent drafts and internal reasoning are not streamed. Progress failures do not
  block the answer, and a durable restart reuses the saved message. The final answer
  edits the first message; extra chunks and deck pictures follow normally. Budget
  denials and errors replace the acknowledgement too. Deleted placeholders fall back
  to a final POST. These Discord updates require no separate model generation.
  To exercise both features through a disposable real old-agent session, run
  `node --conditions=card-cache --env-file=.env.txt scripts/smoke-research.js 8`.
  Discord sends/edits are captured locally; the test incurs bounded AI charges.
- https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- Official game vocabulary lives in `claude/terminology.json`, bundled into the
  worker. Each entry has Traditional Chinese, English and Japanese names plus
  the official definition; the file records its source URLs and verification date.
  `query_svwb_data(resource=terminology)` reads this file without network access.
  Query one or more terms, or paginate the directory with `offset`/`limit`.
  `view=terms` returns names only; `view=definitions` also returns meanings.
  Normal prompts contain only a short rule and relevant matches, not the full
  glossary. Unknown terms remain explicitly missing and require official research.
  When official terms change, review the two source endpoints with `lang: cht`,
  `en`, and `ja`, update the JSON/date, and redeploy; no per-message refresh runs.
- Longer research answers receive one tool-free editorial pass using the existing
  turn budget and answer reserve. Full lists remain complete. Official deck links
  are localized to Traditional Chinese in the answer; the following PNG/code
  message does not repeat a link already delivered in that answer.
  If this optional edit exhausts its allowance, the completed original answer is
  retained. Reading an official hash deck URL fetches its structured Chinese
  cards/effects and Japanese aliases matched by the same card IDs, rather than
  the site's HTML shell. Exact deck evidence and links survive the final writer's
  bounded evidence preparation; repeated source results are deduplicated.
  Already requested public reads interrupted at the research threshold can still
  supply the final writer, within the same external/local read limits. They do not restart
  paid research or execute renderer/chat actions. A final answer with Japanese
  labels gets at most one repair in the same completion session and allowance.
- https://platform.claude.com/docs/en/managed-agents/budgets
- https://docs.discord.com/developers/events/gateway
- https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/
