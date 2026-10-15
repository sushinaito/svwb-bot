# Dice, random cards, and the custom card renderer

The `svwb-fun-bot` Worker adds four guild commands to the existing Discord application.
It is independent of the conversational bot and uses no model calls. Its `/interactions`
route verifies Discord signatures and handles only its four commands and card modals.
Every other signed interaction is forwarded unchanged to the original live
`svwb-deck-bot` endpoint, retaining the live deck code and stored collections.
Do not redeploy the older `src/worker.js` in this repository.

## Commands

- `/roll dice:2d6+3`: individual results and total; 1–50 dice, 2–100000 sides.
- `/random-craft`: uniform selection among the seven playable crafts.
- `/random-card craft:龍族 cost:2 rarity:傳說`: uniform choice from matching card identities.
  Defaults to rotation and excludes tokens and alternate versions. `format:all`
  includes rotated sets; `tokens:true` adds tokens including tokens without format
  legality; `neutral:true` adds Neutral cards to the selected craft.
  Source data is cached for five minutes from SVWB Meta; the response links to the
  official card page and displays its official Traditional Chinese card image.
- `/make-card craft:龍族 cost:5 attack:4 defense:6 artwork:<attachment>`:
  opens a modal for card name, effect, evolution effect, super-evolution effect,
  and author. `type` supports follower/spell/amulet and `rarity` chooses its label.
  Submit within 15 minutes. Artwork is optional; PNG/JPEG only, maximum 2 MiB,
  4096 pixels per side and 4 million pixels total. Artwork is center-cropped.
  Uses the exact WB maker runtime, frames, class backgrounds and fonts.
  `style:effect` (default) returns its 1920×1080 effect panel; `style:card`
  returns its 782×1024 card image without effect text. `trait`, `illustrator`
  and `special:style_101` are also supported. The Discord response labels the
  result as DIY/nonofficial and credits the original maker.
  No artwork generation or balance checking is performed.

## Renderer API

`POST https://svwb-fun-bot.svwb-deckhelper.workers.dev/v1/cards/render`

Send `Authorization: Bearer <RENDER_API_TOKEN>` and `Content-Type: application/json`.
Success is `image/png`; errors return JSON. Example body:

```json
{
  "name": "月光的守護者",
  "craft": 4,
  "type": "follower",
  "cost": 5,
  "attack": 4,
  "defense": 6,
  "rarity": 4,
  "style": "effect",
  "effect": "【守護】\n【入場曲】抽取1張卡片。",
  "evolved": "【進化時】給予1個敵方從者3點傷害。",
  "superEvolved": "",
  "author": "電競魅魔"
}
```

`craft` is 0=Neutral, 1=Forestcraft, 2=Swordcraft, 3=Runecraft,
4=Dragoncraft, 5=Abysscraft, 6=Havencraft, 7=Portalcraft.
`rarity` is 1=bronze, 2=silver, 3=gold, 4=legendary.
`artwork` optionally contains `data:image/png;base64,...` or JPEG.
Arbitrary remote artwork URLs are not accepted. Name is limited to 36 Unicode
characters, effect to 600, each evolution section to 300, author to 32.
`style` accepts `effect` or `card`. `trait` and `illustrator` allow 40 characters;
`special` accepts `style_101`. Optional `crop: {x,y,w,h}` is a normalized rectangle
inside the uploaded artwork. The same `[b]`, `[i]`, `[hr]` and bracket highlighting
as the website is supported. Effect text starts at the site's 32.4px size; long
input is reduced to fit, or rejected when it cannot fit without clipping.
The renderer bounds input sizes and renders strings as card text, not HTML.
Our API wraps a pinned copy of the original WB maker WebAssembly renderer, which
is self-hosted with its matching Traditional Chinese font chunks and backgrounds.
See `vendor/README.md` for provenance. User artwork is processed only on our service.

## Deploy and activate

1. `npm ci`, `npm run fun:prepare` (downloads hash-pinned upstream resources),
   then `npm test`. Downloaded third-party runtime and assets are Git-ignored.
2. Create a random `RENDER_API_TOKEN` in the Git-ignored `.fun-secrets.json`.
3. `npm run fun:deploy`, then
   `wrangler secret bulk .fun-secrets.json --config wrangler.fun.json`.
4. `npm run fun:smoke` checks live PNG rendering, authentication, card pools and images.
5. Point `CHAT_SECRETS_FILE` to the existing local chat secrets file, then run
   `npm run fun:activate`. The bot token stays local. This switches only the
   application's interactions URL and upserts our four commands in each allowed
   guild. Existing global commands are read and verified unchanged.
6. The original endpoint and IDs of newly registered commands are recorded in
   `.wrangler/fun/activation.json`. `node scripts/activate-fun.js --rollback`
   restores the old URL and removes only this activation's recorded guild commands.

No Discord channel messages are sent by setup or the smoke test. Interactive
acceptance of the actual slash-command picker/modal requires a real Discord user.
The command handler responds to interactions, rather than posting unsolicited messages.
The API key is stored locally in `.fun-secrets.json` and in Cloudflare Secrets.
Do not put it in a public browser application.

## Limits and maintenance

Commands are limited to 10/minute and 300/day per user. Rendering has a shared
20/minute and 300/day ceiling (UTC day). These are application usage limits,
not billing guarantees; Cloudflare usage is separate from the AI budget.
Drafts and deduplication records expire automatically; completed PNGs are not stored
by our service. Each generated PNG is attached to its original Discord response.
Failed artwork loading produces an error rather than silently omitting the upload.
Rendering runs in a serialized Durable Object to bound peak memory and provide
enough CPU time for PNG composition. Bundled game assets retain their owners' rights.
