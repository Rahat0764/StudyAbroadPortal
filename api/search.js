// pages/api/search.js
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: rateLimitMap & activeRequests are module-level.
// Vercel warm instances reuse them — best-effort rate limiting.
// ─────────────────────────────────────────────────────────────────────────────

const rateLimitMap = new Map();
let activeRequests = 0;
const MAX_CONCURRENT = 20;
const MAX_RPM = 15;

setInterval(() => rateLimitMap.clear(), 60_000);

// ── Confirmed Gemini model IDs (verified screenshot Apr 2025) ─────────────────
const GEMINI_MODELS = [
  { id: "gemini-2.5-flash",              rpm: 5  },
  { id: "gemini-2.5-flash-lite",         rpm: 10 },
  { id: "gemini-3-flash-preview",        rpm: 5  },
  { id: "gemini-3.1-flash-lite-preview", rpm: 15 },
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

function tgSend(botToken, chatId, html) {
  if (!botToken || !chatId) return;
  fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  }).catch(() => {});
}

export default async function handler(req, res) {
  // ── CORS ───────────────────────────────────────────────────────────────────
  const origin = req.headers.origin || "";
  const isAllowed =
    !origin ||
    ALLOWED_ORIGINS.some((o) => origin.includes(o)) ||
    (process.env.NEXT_PUBLIC_SITE_URL && origin === process.env.NEXT_PUBLIC_SITE_URL);

  if (!isAllowed && process.env.NODE_ENV === "production")
    return res.status(403).json({ error: "Forbidden origin" });

  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── Guards ─────────────────────────────────────────────────────────────────
  if (activeRequests >= MAX_CONCURRENT)
    return res.status(503).json({ error: "Server too busy. Try again shortly." });
  if (JSON.stringify(req.body || {}).length > 10_000)
    return res.status(413).json({ error: "Payload too large" });

  // ── Real IP ────────────────────────────────────────────────────────────────
  const ip =
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  // ── Per-IP rate limit ──────────────────────────────────────────────────────
  const reqCount = rateLimitMap.get(ip) || 0;
  if (reqCount >= MAX_RPM)
    return res.status(429).json({ error: "Too many requests. Please wait a minute." });
  rateLimitMap.set(ip, reqCount + 1);

  // ── Validate body ──────────────────────────────────────────────────────────
  const { prompt, locationData, searchQuery } = req.body || {};
  if (!prompt || typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000)
    return res.status(400).json({ error: "Invalid prompt" });

  // ── Full geo ───────────────────────────────────────────────────────────────
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
  const mapsUrl = geo.lat && geo.lon
    ? `https://www.google.com/maps?q=${geo.lat},${geo.lon}`
    : null;

  // ── Keys ───────────────────────────────────────────────────────────────────
  const apiKeysString = process.env.GEMINI_API_KEYS;
  if (!apiKeysString) return res.status(500).json({ error: "Server config error" });
  const validKeys = apiKeysString.split(",").map((k) => k.trim()).filter(Boolean);
  if (!validKeys.length) return res.status(500).json({ error: "No API keys configured" });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

  // ── Attempt log (all tries, for Telegram) ─────────────────────────────────
  const attempts = [];

  let finalText  = null;
  let usedKeyIdx = -1;
  let usedModel  = "";
  const startMs  = Date.now();

  activeRequests++;

  try {
    outer:
    for (let k = 0; k < validKeys.length; k++) {
      for (const model of GEMINI_MODELS) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${validKeys[k]}`;
        const ctrl = new AbortController();
        // 28s — enough for Gemini+GoogleSearch; shorter = faster fail on bad models
        const timer = setTimeout(() => ctrl.abort(), 28_000);

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
            // Parse error quickly — quota hits return 429 fast, no need to wait
            const errBody = await r.json().catch(() => ({}));
            const errMsg  = errBody?.error?.message || `HTTP ${r.status}`;
            const isQuota = r.status === 429 || /quota|exhausted|rate.?limit/i.test(errMsg);
            attempts.push({
              key:    k + 1,
              model:  model.id,
              status: isQuota ? "⏭ quota/rate-limit" : `❌ HTTP ${r.status}`,
              detail: errMsg.slice(0, 120),
            });
            // Quota hit → skip immediately (no sleep needed, response is instant)
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
          `  ${a.status} — Key#${a.key} | <code>${esc(a.model)}</code>${
            a.detail ? ` → ${esc(a.detail)}` : ""
          }`
      )
      .join("\n");

    const responsePreview = finalText
      ? esc(finalText.slice(0, 2500)) + (finalText.length > 2500 ? "\n…" : "")
      : "❌ No result generated.";

    const tgMsg = [
      `🔍 <b>BideshPro — New Search</b>`,
      ``,
      `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
      `🏙 <b>City:</b> ${esc(geo.city)}, ${esc(geo.region)}`,
      `🌍 <b>Country:</b> ${esc(geo.country)} (${esc(geo.countryCode)})`,
      `🏢 <b>ISP/Org:</b> ${esc(geo.org)}`,
      `📮 <b>Postal:</b> ${esc(geo.postal)}`,
      `🕐 <b>Timezone:</b> ${esc(geo.timezone)}`,
      geo.lat && geo.lon
        ? `📍 <b>Coords:</b> <code>${geo.lat}, ${geo.lon}</code>`
        : `📍 <b>Coords:</b> N/A`,
      mapsUrl ? `🗺 <a href="${mapsUrl}">Open in Google Maps</a>` : null,
      ``,
      `🔎 <b>Query:</b> <code>${esc(safeQuery.slice(0, 200))}</code>`,
      `⏱ <b>Total time:</b> ${elapsed}s`,
      ``,
      `🤖 <b>Model Attempts (${attempts.length} total):</b>`,
      attemptLines || "  (none recorded)",
      finalText
        ? `\n✅ <b>Used:</b> Key#${usedKeyIdx} | <code>${esc(usedModel)}</code>`
        : `\n❌ <b>Result: All models failed</b>`,
      ``,
      `📝 <b>AI Response (preview):</b>`,
      `<pre>${responsePreview}</pre>`,
    ]
      .filter((l) => l !== null)
      .join("\n");

    // Fire & forget — never block the API response for Telegram
    tgSend(botToken, chatId, tgMsg);

    if (!finalText) {
      const last = attempts[attempts.length - 1];
      return res.status(500).json({
        error: `All models failed. Last attempt: ${last?.status || "unknown"} — ${last?.detail || "no detail"}`,
      });
    }

    return res.status(200).json({ text: finalText });
  } finally {
    activeRequests--;
  }
}