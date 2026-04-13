// pages/api/search.js
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: rateLimitMap & activeRequests are in-memory.
// In Vercel, warm instances ARE reused, so this gives best-effort protection.
// For bulletproof rate limiting, use Upstash Redis.
// ─────────────────────────────────────────────────────────────────────────────

const rateLimitMap = new Map();
let activeRequests = 0;
const MAX_CONCURRENT = 20;
const MAX_RPM = 15;

// Auto-clear every 60s
setInterval(() => rateLimitMap.clear(), 60_000);

// Confirmed correct model IDs (verified Apr 2025)
const GEMINI_MODELS = [
  { id: "gemini-2.5-flash",                rpm: 5  },
  { id: "gemini-2.5-flash-lite",           rpm: 10 },
  { id: "gemini-3-flash-preview",          rpm: 5  },
  { id: "gemini-3.1-flash-lite-preview",   rpm: 15 },
];

// Allowed origins — add your Vercel domain here
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  process.env.NEXT_PUBLIC_SITE_URL,
].filter(Boolean);

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  const origin = req.headers.origin || "";
  const isAllowed =
    !origin ||
    ALLOWED_ORIGINS.length === 0 ||
    ALLOWED_ORIGINS.includes(origin);

  if (!isAllowed && process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── Concurrent guard ───────────────────────────────────────────────────────
  if (activeRequests >= MAX_CONCURRENT) {
    return res.status(503).json({ error: "Server too busy. Try again shortly." });
  }

  // ── Payload size ──────────────────────────────────────────────────────────
  if (JSON.stringify(req.body || {}).length > 10_000) {
    return res.status(413).json({ error: "Payload too large" });
  }

  // ── Real IP extraction (Vercel-safe) ──────────────────────────────────────
  const ip =
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  // ── Per-IP rate limit ─────────────────────────────────────────────────────
  const reqCount = rateLimitMap.get(ip) || 0;
  if (reqCount >= MAX_RPM) {
    return res.status(429).json({ error: "Too many requests. Please wait a minute." });
  }
  rateLimitMap.set(ip, reqCount + 1);

  // ── Body validation ────────────────────────────────────────────────────────
  const { prompt, locationData, searchQuery } = req.body || {};
  if (
    !prompt ||
    typeof prompt !== "string" ||
    prompt.trim().length === 0 ||
    prompt.length > 4000
  ) {
    return res.status(400).json({ error: "Invalid prompt" });
  }

  // ── Sanitize geo fields ────────────────────────────────────────────────────
  const geo = {
    city:      String(locationData?.city      || "Unknown").slice(0, 60),
    region:    String(locationData?.region    || "Unknown").slice(0, 60),
    country:   String(locationData?.country   || "Unknown").slice(0, 60),
    countryCode: String(locationData?.countryCode || "??").slice(0, 4),
    org:       String(locationData?.org       || "Unknown").slice(0, 120),
    timezone:  String(locationData?.timezone  || "Unknown").slice(0, 60),
    postal:    String(locationData?.postal    || "Unknown").slice(0, 20),
    lat:       parseFloat(locationData?.latitude)  || null,
    lon:       parseFloat(locationData?.longitude) || null,
  };
  const safeQuery = String(searchQuery || "Unknown").slice(0, 400);

  // ── Keys ───────────────────────────────────────────────────────────────────
  const apiKeysString = process.env.GEMINI_API_KEYS;
  if (!apiKeysString) return res.status(500).json({ error: "Server config error" });

  const validKeys = apiKeysString.split(",").map(k => k.trim()).filter(Boolean);
  if (validKeys.length === 0) return res.status(500).json({ error: "No API keys configured" });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

  // ── Gemini call ────────────────────────────────────────────────────────────
  let finalText   = null;
  let usedKey     = -1;
  let usedModel   = "";
  let lastErr     = "";
  const startTime = Date.now();

  activeRequests++;

  try {
    outer:
    for (let k = 0; k < validKeys.length; k++) {
      for (const model of GEMINI_MODELS) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${validKeys[k]}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30_000);

        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              tools: [{ google_search: {} }],
              generationConfig: {
                temperature: 0.65,
                maxOutputTokens: 4096,
              },
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);

          if (r.ok) {
            const d = await r.json();
            finalText = d.candidates?.[0]?.content?.parts?.[0]?.text || "No result.";
            usedKey   = k + 1;
            usedModel = model.id;
            break outer;
          } else {
            const e = await r.json().catch(() => ({}));
            lastErr = e?.error?.message || `HTTP ${r.status}`;
          }
        } catch (err) {
          clearTimeout(timer);
          lastErr = err.name === "AbortError" ? "Timeout (30s)" : err.message;
        }
      }
    }

    if (!finalText) {
      return res.status(500).json({ error: "All models failed. Last: " + lastErr });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ── Telegram log ─────────────────────────────────────────────────────────
    if (botToken && chatId) {
      const mapsUrl =
        geo.lat && geo.lon
          ? `https://www.google.com/maps?q=${geo.lat},${geo.lon}`
          : null;

      const escHtml = (s) =>
        String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

      const preview = escHtml(finalText.slice(0, 2200));

      const lines = [
        `🔍 <b>BideshPro — New Search</b>`,
        ``,
        `👤 <b>IP:</b> <code>${ip}</code>`,
        `🌆 <b>City:</b> ${escHtml(geo.city)}, ${escHtml(geo.region)}`,
        `🌍 <b>Country:</b> ${escHtml(geo.country)} (${geo.countryCode})`,
        `🏢 <b>ISP/Org:</b> ${escHtml(geo.org)}`,
        `📮 <b>Postal:</b> ${escHtml(geo.postal)}`,
        `🕐 <b>Timezone:</b> ${escHtml(geo.timezone)}`,
        geo.lat && geo.lon
          ? `📍 <b>Coords:</b> <code>${geo.lat}, ${geo.lon}</code>`
          : `📍 <b>Coords:</b> N/A`,
        mapsUrl ? `🗺 <a href="${mapsUrl}">Open in Google Maps</a>` : "",
        ``,
        `🔎 <b>Query:</b> <code>${escHtml(safeQuery.slice(0, 300))}</code>`,
        `🤖 <b>Model:</b> Key#${usedKey} | ${usedModel}`,
        `⏱ <b>Time:</b> ${elapsed}s`,
        ``,
        `📝 <b>AI Response (preview):</b>`,
        `<pre>${preview}…</pre>`,
      ]
        .filter((l) => l !== null)
        .join("\n");

      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: lines,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        }),
      }).catch(() => {});
    }

    return res.status(200).json({ text: finalText });
  } finally {
    activeRequests--;
  }
}