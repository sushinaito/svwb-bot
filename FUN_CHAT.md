# Natural chat actions

Mention the bot, reply to her message, or continue an opted-in thread. The model can call `roll_dice`, `pick_random_card`, `pick_random_craft`, and `make_custom_card` directly. Both new and existing conversations receive these tools without a history reset.

Examples:

- `幫我擲 2d20+3`
- `隨機挑一張龍族傳說卡`
- `幫我做一張龍族3費4/5的傳說從者，名字叫星火幼龍，入場曲抽1張卡片`
- `把剛剛那張改成5費，其他不變`
- Upload a PNG/JPG and ask her to use it as the illustration. Attachments can also come from the message being replied to. Rendering accepts up to 2 MB, at most 4096 pixels per side and 4 million pixels total. Without artwork, the original maker leaves the illustration area blank.

The chat worker imports the same dice, card-selection and validation modules used by slash commands. Card images go through the deployed `svwb-fun-bot` service and its exact WB maker renderer. Configure the `FUN` service binding and secret `FUN_API_TOKEN` (the renderer's `RENDER_API_TOKEN`). Never put either token into tracked config.

Conversation tool results persist before delivery; Discord nonce deduplication covers ambiguous delivery retries. Random results are reused on retries. Edits preserve the last successful card and attachment for that user in the conversation; a different thread participant cannot edit it through `reuse_previous`. Reset clears the stored card. At most three entertainment actions execute per message, under the normal chat admission and AI budget limits; renderer limits also apply.

Validation: `node --test test/*.test.js`. `node scripts/smoke-fun-chat.js` exercises the actual AI tool loop and deployed renderer, including upgrading an existing session and editing a card. It captures all Discord posts locally, writes rendered PNGs under `.wrangler/`, and deletes its temporary AI session. The smoke script expects the local chat config/secrets and the fun worker secrets in the sibling `svwb-fun-cards` checkout.
