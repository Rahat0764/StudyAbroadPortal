// Main
const rateLimitMap = new Map();
let activeRequests = 0;
const MAX_CONCURRENT = 20;
const MAX_RPM = 15;

setInterval(() => rateLimitMap.clear(), 60_000);

const GEMINI_MODELS = [
  { id: "gemini-2.5-flash",                rpm: 5  },
  { id: "gemini-2.5-flash-lite",           rpm: 10 },
  { id: "gemini-3-flash-preview",          rpm: 5  },
  { id: "gemini-3.1-flash-lite-preview",   rpm: 15 },
];

const ALLOWED_ORIGINS = [
  "bidesh.pro.bd",
  "vercel.app",
  "localhost"
];

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  
  const isAllowed =
    !origin ||
    ALLOWED_ORIGINS.some(allowed => origin.includes(allowed)) ||
    (process.env.NEXT_PUBLIC_SITE_URL && origin === process.env.NEXT_PUBLIC_SITE_URL);

  if (!isAllowed && process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (activeRequests >= MAX_CONCURRENT) return res.status(503).json({ error: "Server too busy" });
  if (JSON.stringify(req.body || {}).length > 10_000) return res.status(413).json({ error: "Payload too large" });

  const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const reqCount = rateLimitMap.get(ip) || 0;
  
  if (reqCount >= MAX_RPM) return res.status(429).json({ error: "Too many requests" });
  rateLimitMap.set(ip, reqCount + 1);

  const { prompt, locationData, searchQuery } = req.body || {};
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > 4000) {
    return res.status(400).json({ error: "Invalid prompt" });
  }

  const geo = {
    city: String(locationData?.city || "Unknown").slice(0, 60),
    country: String(locationData?.country || "Unknown").slice(0, 60),
    org: String(locationData?.org || "Unknown").slice(0, 120),
  };
  const safeQuery = String(searchQuery || "Unknown").slice(0, 400);

  const apiKeysString = process.env.GEMINI_API_KEYS;
  if (!apiKeysString) return res.status(500).json({ error: "Server config error" });

  const validKeys = apiKeysString.split(",").map(k => k.trim()).filter(Boolean);
  if (validKeys.length === 0) return res.status(500).json({ error: "No API keys configured" });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

  let finalText = null;
  let usedKey = -1;
  let usedModel = "";

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
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);

          if (r.ok) {
            const d = await r.json();
            finalText = d.candidates?.[0]?.content?.parts?.[0]?.text || "No result.";
            usedKey = k + 1; usedModel = model.id; break outer;
          }
        } catch (err) { clearTimeout(timer); }
      }
    }

    if (!finalText) return res.status(500).json({ error: "All models failed to generate content." });

    if (botToken && chatId) {
      const escapedResult = finalText.substring(0, 3500).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const msg = `🚨 <b>Search Alert!</b>\n👤 <b>IP:</b> ${ip}\n🌍 <b>Loc:</b> ${geo.city}, ${geo.country}\n🏢 <b>ISP:</b> ${geo.org}\n🔍 <b>Q:</b> ${safeQuery}\n🤖 <b>API:</b> K#${usedKey} | ${usedModel}\n\n📝 <b>AI Response:</b>\n<pre>${escapedResult}</pre>`;
      
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
      }).catch(() => {});
    }

    return res.status(200).json({ text: finalText });
  } finally { activeRequests--; }
}