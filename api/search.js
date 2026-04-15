const rateLimitMap = new Map();
let activeRequests = 0;
const MAX_CONCURRENT = 20;
const MAX_RPM = 15;

setInterval(() => rateLimitMap.clear(), 60_000);

// ── Confirmed Gemini model IDs ───────────────────────────────────────────────
const GEMINI_MODELS = [
  { id: "gemini-3-flash-preview",        rpm: 5  },
  { id: "gemini-2.5-flash",              rpm: 5  },
  { id: "gemini-3.1-flash-lite-preview", rpm: 15 },
  { id: "gemini-2.5-flash-lite",         rpm: 10 },
];

const ALLOWED_ORIGINS = [
  "bidesh.pro.bd",
  "www.bidesh.pro.bd",
  "vercel.app",
  "localhost",
];

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

async function tgSend(botToken, chatId, html) {
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (error) {
    console.error("Telegram send failed:", error);
  }
}

export default async function handler(req, res) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  const startMs  = Date.now();

  // ── Real IP & Geo (Parsed early for global logging) ────────────────────────
  const ip =
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const { prompt, locationData, searchQuery } = req.body || {};
  
  const geo = {
    city:        String(locationData?.city        || "Unknown").slice(0, 60),
    region:      String(locationData?.region      || "Unknown").slice(0, 60),
    country:     String(locationData?.country     || "Unknown").slice(0, 60),
    countryCode: String(locationData?.countryCode || "??").slice(0, 4),
    org:         String(locationData?.org         || "Unknown").slice(0, 120),
    timezone:    String(locationData?.timezone    || "Unknown").slice(0, 60),
    postal:      String(locationData?.postal      || "Unknown").slice(0, 20),
    lat:         parseFloat(locationData?.latitude)  || null,
    lon:         parseFloat(locationData?.longitude) || null,
  };
  const safeQuery = String(searchQuery || "Unknown").slice(0, 400);

  // Helper to log early errors to Telegram before returning
  const logAndReturnError = async (statusCode, clientMsg, tgDetail) => {
    const errorMsg = [
      `🚨 <b>BideshPro API Error (Early Exit)</b>`,
      ``,
      `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
      `🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.country)}`,
      `🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>`,
      `🛑 <b>Status Code:</b> ${statusCode}`,
      `⚠️ <b>Reason:</b> ${esc(tgDetail)}`
    ].join("\n");
    await tgSend(botToken, chatId, errorMsg);
    return res.status(statusCode).json({ error: clientMsg });
  };

  // ── CORS ───────────────────────────────────────────────────────────────────
  const origin = req.headers.origin || "";
  const isAllowed =
    !origin ||
    ALLOWED_ORIGINS.some((o) => origin.includes(o)) ||
    (process.env.NEXT_PUBLIC_SITE_URL && origin === process.env.NEXT_PUBLIC_SITE_URL);

  if (!isAllowed && process.env.NODE_ENV === "production")
    return logAndReturnError(403, "Forbidden origin", `CORS blocked for origin: ${origin}`);

  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return logAndReturnError(405, "Method not allowed", `Invalid method: ${req.method}`);

  // ── Guards ─────────────────────────────────────────────────────────────────
  if (activeRequests >= MAX_CONCURRENT)
    return logAndReturnError(503, "Server too busy. Try again shortly.", "MAX_CONCURRENT reached");
  
  if (JSON.stringify(req.body || {}).length > 20_000)
    return logAndReturnError(413, "Payload too large", "Request body exceeded 20KB");

  // ── Per-IP rate limit ──────────────────────────────────────────────────────
  const reqCount = rateLimitMap.get(ip) || 0;
  if (reqCount >= MAX_RPM)
    return logAndReturnError(429, "Too many requests. Please wait a minute.", `Rate limit hit (${reqCount} reqs)`);
  rateLimitMap.set(ip, reqCount + 1);

  // ── Validate body (INCREASED LIMIT TO 12000 to fix "Invalid Prompt") ───────
  if (!prompt || typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000)
    return logAndReturnError(400, "Invalid prompt", `Prompt validation failed. Length: ${prompt?.length || 0}`);

  const mapsUrl = geo.lat && geo.lon
    ? `https://www.google.com/maps?q=${geo.lat},${geo.lon}`
    : null;

  // ── Keys ───────────────────────────────────────────────────────────────────
  const apiKeysString = process.env.GEMINI_API_KEYS;
  if (!apiKeysString) return logAndReturnError(500, "Server config error", "GEMINI_API_KEYS missing");
  const validKeys = apiKeysString.split(",").map((k) => k.trim()).filter(Boolean);
  if (!validKeys.length) return logAndReturnError(500, "No API keys configured", "GEMINI_API_KEYS array is empty");

  // ── Attempt log ────────────────────────────────────────────────────────────
  const attempts = [];
  let finalText  = null;
  let usedKeyIdx = -1;
  let usedModel  = "";

  activeRequests++;

  try {
    outer:
    for (let k = 0; k < validKeys.length; k++) {
      for (const model of GEMINI_MODELS) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${validKeys[k]}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 18_000);

        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              tools: [{ google_search: {} }],
              generationConfig: { temperature: 0.65, maxOutputTokens: 4096 },
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);

          if (r.ok) {
            const d = await r.json();
            const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              finalText  = text;
              usedKeyIdx = k + 1;
              usedModel  = model.id;
              attempts.push({ key: k + 1, model: model.id, status: "✅ success", detail: "" });
              break outer;
            }
            attempts.push({ key: k + 1, model: model.id, status: "⚠️ empty response", detail: "" });
          } else {
            const errBody = await r.json().catch(() => ({}));
            const errMsg  = errBody?.error?.message || `HTTP ${r.status}`;
            const isQuota = r.status === 429 || /quota|exhausted|rate.?limit/i.test(errMsg);
            attempts.push({
              key:    k + 1,
              model:  model.id,
              status: isQuota ? "⏭ quota/rate-limit" : `❌ HTTP ${r.status}`,
              detail: errMsg.slice(0, 120),
            });
          }
        } catch (err) {
          clearTimeout(timer);
          const isTimeout = err.name === "AbortError";
          attempts.push({
            key:    k + 1,
            model:  model.id,
            status: isTimeout ? "⏱ timeout (28s)" : "❌ exception",
            detail: isTimeout ? "" : err.message.slice(0, 80),
          });
        }
      }
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

    // ── Telegram: all attempts + geo + result preview ──────────────────────
    const attemptLines = attempts
      .map(
        (a) =>
          `${a.status} — Key#${a.key} | <code>${esc(a.model)}</code>${
            a.detail ? `\n    └ <i>${esc(a.detail)}</i>` : ""
          }`
      )
      .join("\n");

    const responsePreview = finalText
      ? esc(finalText.slice(0, 1500)) + (finalText.length > 1500 ? "\n[... truncated]" : "")
      : "❌ No result generated.";

    const tgMsg = [
      `🔍 <b>BideshPro — New AI Query</b>`,
      ``,
      `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
      `🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.region)}, ${esc(geo.country)} (${esc(geo.countryCode)})`,
      `🏢 <b>Org:</b> ${esc(geo.org)}`,
      `🕐 <b>Timezone:</b> ${esc(geo.timezone)} | <b>Postal:</b> ${esc(geo.postal)}`,
      mapsUrl ? `🗺 <a href="${mapsUrl}">View on Google Maps</a> (${geo.lat}, ${geo.lon})` : `📍 <b>Coords:</b> N/A`,
      ``,
      `🔎 <b>Search/Cache Key:</b> <code>${esc(safeQuery)}</code>`,
      `⏱ <b>Total response time:</b> ${elapsed}s`,
      ``,
      `🤖 <b>Model Attempts (${attempts.length} total):</b>`,
      attemptLines || "  (none recorded)",
      ``,
      finalText
        ? `✅ <b>FINAL SUCCESS:</b> Key#${usedKeyIdx} | <code>${esc(usedModel)}</code>`
        : `❌ <b>RESULT: All keys and models failed</b>`,
      ``,
      `📝 <b>AI Response Preview:</b>`,
      `<pre>${responsePreview}</pre>`,
    ].filter((l) => l !== null).join("\n");

    await tgSend(botToken, chatId, tgMsg);

    if (!finalText) {
      const last = attempts[attempts.length - 1];
      return res.status(500).json({
        error: `All models failed. Last attempt: ${last?.status || "unknown"} — ${last?.detail || "no detail"}`,
      });
    }

    return res.status(200).json({ text: finalText });
  } catch (error) {
    // Catch absolute failures (e.g. Node.js crash)
    await logAndReturnError(500, "Internal Server Error", error.message);
  } finally {
    activeRequests--;
  }
}