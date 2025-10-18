// Register the /deck command (guild-scoped or global) via Discord API v10
// Env vars required:
// - DISCORD_TOKEN      (Bot token, starts with "MT..." or similar)
// - APPLICATION_ID     (Discord Application ID)
// - GUILD_ID           (Optional: target guild for faster iteration)

const { DISCORD_TOKEN, APPLICATION_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !APPLICATION_ID) {
  console.error("Missing DISCORD_TOKEN or APPLICATION_ID env vars.");
  process.exit(1);
}

const DISCORD_API = "https://discord.com/api/v10";

const commands = [
  {
    name: "deck",
    description: "Return Shadowverse WB deck image by 4-letter code",
    type: 1,
    options: [
      {
        name: "code",
        description: "4-letter deck code (e.g., ukge)",
        type: 3,
        required: true,
      },
      {
        name: "hash",
        description: "Optional full deck hash to force exact image",
        type: 3,
        required: false,
      },
      {
        name: "lang",
        description: "Language (default: en)",
        type: 3,
        required: false,
        choices: [
          { name: "English", value: "en" },
          { name: "日本語", value: "ja" }
        ],
      },
    ],
  },
];

const route = GUILD_ID
  ? `${DISCORD_API}/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`
  : `${DISCORD_API}/applications/${APPLICATION_ID}/commands`;

async function main() {
  const res = await fetch(route, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const err = await safeText(res);
    console.error("Failed to register commands:", res.status, err);
    process.exit(1);
  }
  const data = await res.json();
  console.log("Registered commands:", JSON.stringify(data, null, 2));
}

async function safeText(r) {
  try {
    return await r.text();
  } catch (e) {
    return "<no-body>";
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
