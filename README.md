Shadowverse WB Deck Bot (Cloudflare Workers)

This Worker exposes a Discord Interactions endpoint that serves a `/deck` slash command.
Users provide a 4-letter deck code and the bot replies with the deck image from shadowverse-wb.com.

Files
- `wrangler.toml:1` — Worker config (entry, compatibility date).
- `src/worker.js:1` — Discord signature verify, `/deck` handler, image scraping.
- `scripts/register-commands.js:1` — Registers the slash command via Discord API.

Prereqs
- A Discord application (copy its Public Key and Application ID).
- Cloudflare account with Workers + Wrangler CLI installed.

Configure
1) Set Discord Public Key as a secret for the Worker:
   `wrangler secret put DISCORD_PUBLIC_KEY`

2) Deploy the Worker (first deploy creates a URL):
   `wrangler deploy`

3) In your Discord application settings:
   - Point the Interactions Endpoint URL to your Worker URL (e.g., `https://<your-worker>.workers.dev/`).
   - Save changes.

4) Register the slash command (guild-scoped for instant updates):
   - Set env vars and run the script:
     - PowerShell (Windows):
       `$env:DISCORD_TOKEN="<bot-token>"; $env:APPLICATION_ID="<app-id>"; $env:GUILD_ID="<guild-id>"; npm run register:guild`
     - Bash:
       `DISCORD_TOKEN=<bot-token> APPLICATION_ID=<app-id> GUILD_ID=<guild-id> npm run register:guild`
   - Omit `GUILD_ID` to register globally (takes up to 1 hour to propagate).

Usage
- In Discord: `/deck code:<abcd> lang:<en|ja>`
- The bot defers, fetches the builder page, tries to discover a share hash or direct deck image, and uploads the image as an attachment. If no share is exposed, it may fall back to a generic image or just post the deck link.

Notes
- Zero cost: Cloudflare Workers free tier + Discord Interactions (no gateway). No headless browser is used.
- Basic caching: Cloudflare edge cache hints on the deck page fetch.
- If image extraction fails (site changes), the bot posts the deck URL as a fallback.
- Not all 4-letter codes map to a published share. When no share is available, the builder page often doesn’t expose a `hash=...`, so the image may be generic. A future enhancement is to cache known code→hash mappings.
- Troubleshooting endpoint verification: if Discord says "Invalid signature", re-set the secret with your App's Public Key (`wrangler secret put DISCORD_PUBLIC_KEY`), redeploy, and tail logs (`wrangler tail`) to see verify_info lines.
