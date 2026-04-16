const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "50mb" }));

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const PORT = process.env.PORT || 10000;

const rateLimitMap = new Map();
let activeRequests = 0;

const MAX_CONCURRENT = 20;
const MAX_RPM = 15;

setInterval(() => rateLimitMap.clear(), 60_000);

const GEMINI_MODELS = [
  { id: "gemini-3-flash-preview",        rpm: 5  },
  { id: "gemini-2.5-flash",              rpm: 5  },
  { id: "gemini-3.1-flash-lite-preview", rpm: 15 },
  { id: "gemini-2.5-flash-lite",         rpm: 10 },
];

const ALLOWED_ORIGINS = [
  "vercel.app",
  "localhost",
  "bidesh.pro.bd",
  "www.bidesh.pro.bd"
];

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function tgSend(botToken, chatId, html) {
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("Telegram error:", e);
  }
}

// ─────────────────────────────────────────
// CORS
// ─────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowed = !origin || ALLOWED_ORIGINS.some((o) => origin.includes(o));

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────
// HEALTH CHECK ROUTE (For UptimeRobot)
// ─────────────────────────────────────────
app.get("/", (req, res) => {
  res.status(200).send("✅ BideshPro Backend is Awake and Running!");
});

// ─────────────────────────────────────────
// MAIN ROUTE (/api/search)
// ─────────────────────────────────────────
app.post("/api/search", async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  const startMs  = Date.now();

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
  const { prompt, locationData, searchQuery } = req.body || {};
  const safeQuery = String(searchQuery || "Unknown").slice(0, 400);

  // Geo Location Setup for Telegram
  const geo = {
    city:        String(locationData?.city        || "Unknown").slice(0, 60),
    region:      String(locationData?.region      || "Unknown").slice(0, 60),
    country:     String(locationData?.country     || "Unknown").slice(0, 60),
    countryCode: String(locationData?.countryCode || "??").slice(0, 4),
    org:         String(locationData?.org         || "Unknown").slice(0, 120),
    lat:         parseFloat(locationData?.latitude)  || null,
    lon:         parseFloat(locationData?.longitude) || null,
  };
  const mapsUrl = geo.lat && geo.lon ? `https://www.google.com/maps?q=${geo.lat},${geo.lon}` : null;

  // ── Error Logging Helper for Telegram ──
  const logAndReturnError = async (statusCode, clientMsg, tgDetail) => {
    const errorMsg = `🚨 <b>BideshPro API Error</b>\n\n👤 <b>IP:</b> <code>${esc(ip)}</code>\n🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.country)}\n🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>\n🛑 <b>Status:</b> ${statusCode}\n⚠️ <b>Reason:</b> ${esc(tgDetail)}`;
    await tgSend(botToken, chatId, errorMsg);
    return res.status(statusCode).json({ error: clientMsg });
  };

  try {
    if (!prompt || prompt.length > 12000) 
      return logAndReturnError(400, "Invalid prompt", "Prompt is missing or too long (>12000 chars)");
    
    if (activeRequests >= MAX_CONCURRENT) 
      return logAndReturnError(503, "Server busy. Try again.", "MAX_CONCURRENT reached (Too many active requests)");

    const reqCount = rateLimitMap.get(ip) || 0;
    if (reqCount >= MAX_RPM) 
      return logAndReturnError(429, "Too many requests. Wait a minute.", `Rate limit hit for IP (${reqCount} reqs)`);
    
    rateLimitMap.set(ip, reqCount + 1);

    const keys = (process.env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
    if (!keys.length) 
      return logAndReturnError(500, "Server Configuration Error", "No API keys configured in GEMINI_API_KEYS");

    const attempts = [];
    let finalText  = null;
    let usedKeyIdx = -1;
    let usedModel  = "";

    activeRequests++;

    outer:
    for (let k = 0; k < keys.length; k++) {
      for (const model of GEMINI_MODELS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); 

        try {
          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${keys[k]}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                tools: [{ google_search: {} }],
              }),
              signal: controller.signal
            }
          );
          clearTimeout(timeoutId);

          if (r.ok) {
            const d = await r.json();
            const text = d?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              finalText = text;
              usedKeyIdx = k + 1;
              usedModel = model.id;
              attempts.push({ key: k + 1, model: model.id, status: "✅ success" });
              break outer;
            }
          } else {
            const errBody = await r.json().catch(() => ({}));
            const errMsg = errBody?.error?.message || `HTTP ${r.status}`;
            attempts.push({ key: k + 1, model: model.id, status: `❌ HTTP ${r.status}`, detail: errMsg });
          }
        } catch (e) {
          clearTimeout(timeoutId);
          attempts.push({ key: k + 1, model: model.id, status: e.name === "AbortError" ? "⏱ timeout (15s)" : "❌ error", detail: e.message });
        }
      }
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    
    // Format attempts for Telegram
    const attemptLines = attempts
      .map((a) => `${a.status} — Key#${a.key} | <code>${esc(a.model)}</code>${a.detail ? `\n    └ <i>${esc(a.detail.slice(0,100))}</i>` : ""}`)
      .join("\n");

    // Telegram Logging with Full Location details
    if (finalText) {
      const responsePreview = finalText.slice(0, 1000) + (finalText.length > 1000 ? "\n[... truncated]" : "");
      const successMsg = `✅ <b>Success (${elapsed}s)</b>\n\n👤 <b>IP:</b> <code>${esc(ip)}</code>\n🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.country)}\n🏢 <b>ISP:</b> ${esc(geo.org)}\n${mapsUrl ? `🗺 <a href="${mapsUrl}">View Maps</a>\n` : ''}🤖 <b>Model:</b> <code>${usedModel}</code> (Key#${usedKeyIdx})\n🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>\n\n📝 <b>Preview:</b>\n<pre>${esc(responsePreview)}</pre>`;
      await tgSend(botToken, chatId, successMsg);
      return res.json({ text: finalText });
    } else {
      const failMsg = `❌ <b>All Models Failed (${elapsed}s)</b>\n\n👤 <b>IP:</b> <code>${esc(ip)}</code>\n🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>\n\n🤖 <b>Attempts:</b>\n${attemptLines}`;
      await tgSend(botToken, chatId, failMsg);
      return res.status(500).json({ error: "All AI models are currently busy or failed. Please try again." });
    }
  } catch (globalError) {
    // Catch absolute server crashes
    await logAndReturnError(500, "Internal Server Error", globalError.message);
  } finally {
    activeRequests--;
  }
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Render Backend is running on port ${PORT}`);
});