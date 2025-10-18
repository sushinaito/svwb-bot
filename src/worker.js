// Cloudflare Worker: Discord Interactions endpoint for Shadowverse WB deck images
// Expects secret: DISCORD_PUBLIC_KEY (Discord application's public key)

const DISCORD_API = "https://discord.com/api/v10";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response("ok", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    // Verify Discord signature
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    if (!signature || !timestamp) {
      return new Response("Bad request", { status: 400 });
    }

    const body = await request.text();
    const isValid = await verifyDiscordRequest(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      console.log("verify_failed", { ts: timestamp });
    } else {
      console.log("verify_ok", { ts: timestamp });
    }
    if (!isValid) {
      return new Response("Invalid signature", { status: 401 });
    }

    let interaction;
    try {
      interaction = JSON.parse(body);
    } catch (e) {
      return new Response("Invalid JSON", { status: 400 });
    }

    // PING
    if (interaction.type === 1) {
      console.log("ping", { id: interaction?.id });
      return json({ type: 1 });
    }

    // Slash command
    if (interaction.type === 2) {
      console.log("command", { name: interaction?.data?.name, id: interaction?.id });
      const name = interaction?.data?.name;
      if (name === "deck") {
        // Parse options
        const code = getOption(interaction, "code")?.toLowerCase() ?? "";
        const langRaw = getOption(interaction, "lang") ?? "en";
        const lang = ["en", "ja"].includes(String(langRaw)) ? String(langRaw) : "en";
        console.log("deck_request", { code, lang });

        // Validate code: 4 alphanumeric characters
        const isValidCode = /^[a-z0-9]{4}$/i.test(code);
        if (!isValidCode) {
          return json({
            type: 4,
            data: {
              content: "Invalid code. Please provide 4 letters/numbers (a–z, 0–9).",
              flags: 64, // ephemeral
            },
          });
        }

        // Acknowledge quickly, then do work asynchronously
        const defer = json({ type: 5 });

        ctx.waitUntil(handleDeckLookup(interaction, code, lang));
        return defer;
      }

      // Unknown command
      return json({
        type: 4,
        data: { content: "Unknown command.", flags: 64 },
      });
    }

    return new Response("Unhandled interaction type", { status: 400 });
  },
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function getOption(interaction, name) {
  const opts = interaction?.data?.options || [];
  const found = opts.find((o) => o?.name === name);
  return found?.value;
}

async function handleDeckLookup(interaction, code, lang) {
  const deckUrl = `https://shadowverse-wb.com/${lang}/deck/build_edit/?battle_format=2&deck_code=${encodeURIComponent(code)}`;
  let imageUrl = null;
  try {
    const res = await fetch(deckUrl, {
      cf: { cacheEverything: true, cacheTtl: 60 * 60 },
      headers: { "user-agent": "Mozilla/5.0 (compatible; svwb-bot/1.0)" },
    });
    const html = await res.text();
    imageUrl = extractDeckImageUrl(html, lang);
    console.log("selected_image_url", { imageUrl, deckUrl });

    // If not found, try the other language page as a fallback
    if (!imageUrl) {
      const otherLang = lang === "en" ? "ja" : "en";
      const otherUrl = `https://shadowverse-wb.com/${otherLang}/deck/build_edit/?battle_format=2&deck_code=${encodeURIComponent(code)}`;
      try {
        const res2 = await fetch(otherUrl, {
          cf: { cacheEverything: true, cacheTtl: 60 * 60 },
          headers: { "user-agent": "Mozilla/5.0 (compatible; svwb-bot/1.0)" },
        });
        const html2 = await res2.text();
        const imageUrl2 = extractDeckImageUrl(html2, otherLang);
        if (imageUrl2) {
          imageUrl = imageUrl2;
          console.log("retry_other_lang_hit", { imageUrl, tried: otherLang });
        } else {
          console.log("retry_other_lang_miss", { tried: otherLang });
        }
      } catch (e) {
        console.log("retry_other_lang_error", { tried: otherLang, message: String(e?.message || e) });
      }
    }
  } catch (e) {
    // ignore, fallback below
  }

  // Build webhook response
  const webhookUrl = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`;

  if (imageUrl) {
    // Try to proxy-upload the image to Discord to avoid external fetch issues
    try {
      const imgRes = await fetch(imageUrl, {
        headers: { "user-agent": "Discordbot/2.0; +https://discordapp.com" },
        cf: { cacheEverything: true, cacheTtl: 60 * 60 },
      });
      if (imgRes.ok) {
        const contentType = (imgRes.headers.get("content-type") || "").toLowerCase();
        const buf = await imgRes.arrayBuffer();
        const size = buf.byteLength;
        console.log("fetched_image_info", { status: imgRes.status, contentType, size });
        if (!contentType.startsWith("image/") || size < 1024) {
          console.log("image_sanity_failed", { contentType, size });
        }
        const filename = `deck_${code}_${lang}.png`;
        const file = new File([buf], filename, { type: contentType });
        const form = new FormData();
        form.set(
          "payload_json",
          JSON.stringify({
            content: `Deck ${code.toUpperCase()} (${lang})`,
            embeds: [
              {
                title: `Shadowverse WB Deck ${code.toUpperCase()}`,
                url: deckUrl,
                image: { url: `attachment://${filename}` },
              },
            ],
            attachments: [
              { id: 0, filename },
            ],
          })
        );
        // Use append to ensure proper filename propagation
        form.append("files[0]", file, filename);
        const postRes = await fetch(webhookUrl, { method: "POST", body: form });
        if (!postRes.ok) {
          const errText = await safeReadText(postRes);
          console.log("webhook_post_error_attachment", { status: postRes.status, errText });
        } else {
          console.log("responded_with_image_attachment", { code, lang });
        }

        // Also post a secondary message with attachment only (no embed), to
        // bypass any embed rendering issues on some servers.
        try {
          const form2 = new FormData();
          form2.set(
            "payload_json",
            JSON.stringify({ content: `Deck ${code.toUpperCase()} (${lang}) — attachment only` })
          );
          form2.append("files[0]", new File([buf], filename, { type: contentType }), filename);
          const postRes2 = await fetch(webhookUrl, { method: "POST", body: form2 });
          if (!postRes2.ok) {
            const errText2 = await safeReadText(postRes2);
            console.log("webhook_post_error_attachment_only", { status: postRes2.status, errText: errText2 });
          } else {
            console.log("responded_with_attachment_only", { code, lang });
          }
        } catch (e2) {
          console.log("attachment_only_error", { message: String(e2) });
        }
      } else {
        // Fallback to external URL embed
        const postRes = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: `Deck ${code.toUpperCase()} (${lang})`,
            embeds: [
              {
                title: `Shadowverse WB Deck ${code.toUpperCase()}`,
                url: deckUrl,
                image: { url: imageUrl },
              },
            ],
          }),
        });
        if (!postRes.ok) {
          const errText = await safeReadText(postRes);
          console.log("webhook_post_error_url_fallback", { status: postRes.status, errText });
        } else {
          console.log("responded_with_image_url_fallback", { code, lang, status: imgRes.status });
        }
      }
    } catch (err) {
      // Fallback to external URL embed
      const postRes = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: `Deck ${code.toUpperCase()} (${lang})`,
          embeds: [
            {
              title: `Shadowverse WB Deck ${code.toUpperCase()}`,
              url: deckUrl,
              image: { url: imageUrl },
            },
          ],
        }),
      });
      if (!postRes.ok) {
        const errText = await safeReadText(postRes);
        console.log("webhook_post_error_catch_fallback", { status: postRes.status, errText, message: String(err) });
      } else {
        console.log("responded_with_image_url_error", { code, lang, message: String(err) });
      }
    }
  } else {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `Could not extract image for code ${code.toUpperCase()}. You can view the deck here: ${deckUrl}`,
      }),
    });
    console.log("responded_with_link", { code, lang });
  }
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (e) {
    return "<no-body>";
  }
}

function extractDeckImageUrl(html, lang) {
  // Prefer explicit deck image endpoint present in the page content
  const decoded = html.replace(/&amp;/g, "&");

  // 0) If a deck detail link with a hash is present, use that hash to build the image URL
  // Example: /en/deck/detail/?popular=1&hash=...
  const detailLinkMatch = decoded.match(/\/(?:en|ja)\/deck\/detail\/\?[^"'>]*hash=([^"'&<>]+)/i);
  if (detailLinkMatch) {
    const hash = detailLinkMatch[1];
    const url = `https://shadowverse-wb.com/web/Image/deck?hash=${hash}&lang=${lang}`;
    console.log("hash_from_detail", { hash, url });
    return url;
  }

  // 1) Look for the known image path
  const imgPathMatch = decoded.match(/\/(web\/Image\/deck\?hash=[^"'<>&]+)/i);
  if (imgPathMatch) {
    let url = `https://shadowverse-wb.com/${imgPathMatch[1].replace(/^\//, "")}`;
    if (!/([?&])lang=/.test(url)) {
      url += (url.includes("?") ? "&" : "?") + `lang=${lang}`;
    }
    console.log("img_path_match", { url });
    return url;
  }

  // 1b) Try to parse __NEXT_DATA__ JSON and search for a deck hash string
  try {
    const nextDataMatch = decoded.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
      const jsonText = nextDataMatch[1];
      const data = JSON.parse(jsonText);
      const hash = deepFindHashLikeString(data);
      if (hash) {
        const url = `https://shadowverse-wb.com/web/Image/deck?hash=${hash}&lang=${lang}`;
        console.log("hash_from_next_data", { hash, url });
        return url;
      }
    }
  } catch (e) {
    console.log("next_data_parse_error", { message: String(e?.message || e) });
  }

  // 2) Fallback to Open Graph image if present
  const ogMatch = decoded.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (ogMatch) {
    const url = ogMatch[1];
    console.log("og_image_match", { url });
    return url;
  }

  return null;
}

// Heuristic: recursively search a JSON tree for strings that look like a deck hash
function deepFindHashLikeString(node) {
  const seen = new Set();
  function walk(v) {
    if (v == null) return null;
    if (typeof v === "string") {
      // Hashes look like: "2.6.cmmw.cmmw..." etc.
      if (/^\d+\.[0-9]+\.[A-Za-z0-9.\-]+$/.test(v) && v.includes(".")) {
        return v;
      }
      return null;
    }
    if (typeof v === "object") {
      if (seen.has(v)) return null;
      seen.add(v);
      if (Array.isArray(v)) {
        for (const item of v) {
          const hit = walk(item);
          if (hit) return hit;
        }
      } else {
        for (const k of Object.keys(v)) {
          const hit = walk(v[k]);
          if (hit) return hit;
        }
      }
    }
    return null;
  }
  return walk(node);
}

async function verifyDiscordRequest(body, signature, timestamp, publicKeyHex) {
  try {
    const pk = (publicKeyHex || "").trim();
    const msg = new TextEncoder().encode(String(timestamp) + body);
    const sig = hexToUint8(String(signature).trim());
    const pub = hexToUint8(pk);

    console.log("verify_info", {
      body_len: body?.length ?? 0,
      ts_len: String(timestamp).length,
      sig_hex_len: String(signature).trim().length,
      pk_hex_len: pk.length,
    });

    const key = await crypto.subtle.importKey(
      "raw",
      pub,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
  } catch (e) {
    console.log("verify_error", { message: String(e?.message || e) });
    return false;
  }
}

function hexToUint8(hex) {
  if (!hex || typeof hex !== "string") return new Uint8Array();
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}
