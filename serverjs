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
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
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

  if (!prompt || prompt.length > 12000) return res.status(400).json({ error: "Invalid prompt" });
  if (activeRequests >= MAX_CONCURRENT) return res.status(503).json({ error: "Server busy. Try again." });

  const reqCount = rateLimitMap.get(ip) || 0;
  if (reqCount >= MAX_RPM) return res.status(429).json({ error: "Too many requests. Wait a minute." });
  rateLimitMap.set(ip, reqCount + 1);

  const keys = (process.env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!keys.length) return res.status(500).json({ error: "No API keys configured" });

  const attempts = [];
  let finalText  = null;
  let usedKeyIdx = -1;
  let usedModel  = "";

  activeRequests++;

  try {
    outer:
    for (let k = 0; k < keys.length; k++) {
      for (const model of GEMINI_MODELS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout per model

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
            attempts.push({ key: k + 1, model: model.id, status: `❌ HTTP ${r.status}` });
          }
        } catch (e) {
          clearTimeout(timeoutId);
          attempts.push({ key: k + 1, model: model.id, status: e.name === "AbortError" ? "⏱ timeout" : "❌ error" });
        }
      }
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    
    // Telegram Logging
    if (finalText) {
      await tgSend(botToken, chatId, `✅ <b>Success (${elapsed}s)</b>\nIP: <code>${esc(ip)}</code>\nModel: <code>${usedModel}</code>\nQuery: <code>${esc(safeQuery)}</code>`);
      return res.json({ text: finalText });
    } else {
      await tgSend(botToken, chatId, `❌ <b>All Models Failed</b>\nIP: <code>${esc(ip)}</code>\nQuery: <code>${esc(safeQuery)}</code>`);
      return res.status(500).json({ error: "All AI models are currently busy or failed. Please try again." });
    }

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
