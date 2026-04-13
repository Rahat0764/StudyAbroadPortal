const rateLimitMap = new Map();
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 20;
const MAX_REQUESTS_PER_MINUTE = 15;

setInterval(() => rateLimitMap.clear(), 60000);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const origin = req.headers.origin || req.headers.referer || "";
  if (!origin && process.env.NODE_ENV === "production") {}

  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    return res.status(503).json({ error: "Server too busy. Try again later." });
  }

  const payloadString = JSON.stringify(req.body || {});
  if (payloadString.length > 8000) return res.status(413).json({ error: "Payload too large" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown";
  const userRequests = rateLimitMap.get(ip) || 0;
  if (userRequests >= MAX_REQUESTS_PER_MINUTE) {
    return res.status(429).json({ error: "Too many requests. Please wait a minute." });
  }
  rateLimitMap.set(ip, userRequests + 1);

  let { prompt, locationData, searchQuery } = req.body;
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > 2000) {
    return res.status(400).json({ error: "Invalid prompt provided" });
  }

  const safeCity = String(locationData?.city || "Unknown").substring(0, 50);
  const safeCountry = String(locationData?.country || "Unknown").substring(0, 50);
  const safeOrg = String(locationData?.org || "Unknown").substring(0, 100);
  const safeQuery = String(searchQuery || "Unknown").substring(0, 200);

  const apiKeysString = process.env.GEMINI_API_KEYS;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!apiKeysString) return res.status(500).json({ error: "Server configuration error" });

  const validKeys = apiKeysString.split(",").map((k) => k.trim()).filter(Boolean);
  if (validKeys.length === 0) return res.status(500).json({ error: "No valid API keys configured" });

  const GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
  ];

  let lastErrorMsg = "";
  let finalResultText = null;
  let usedKeyIndex = -1;
  let usedModelName = "";

  activeRequests++;

  try {
    for (let kIndex = 0; kIndex < validKeys.length; kIndex++) {
      const currentKey = validKeys[kIndex];
      for (let mIndex = 0; mIndex < GEMINI_MODELS.length; mIndex++) {
        const currentModel = GEMINI_MODELS[mIndex];

        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${currentKey}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 25000);

          const geminiRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              tools: [{ google_search: {} }],
            }),
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (geminiRes.ok) {
            const geminiData = await geminiRes.json();
            finalResultText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "No data found.";
            usedKeyIndex = kIndex + 1;
            usedModelName = currentModel;
            break;
          } else {
            const errData = await geminiRes.json().catch(() => ({}));
            lastErrorMsg = errData?.error?.message || `HTTP ${geminiRes.status}`;
            continue;
          }
        } catch (error) {
          lastErrorMsg = error.message;
          continue;
        }
      }
      if (finalResultText) break;
    }

    if (!finalResultText) {
      return res.status(500).json({ error: "All API models depleted. Last error: " + lastErrorMsg });
    }

    // Telegram Logging with Full Result Quote
    if (botToken && chatId) {
      const escapedResult = finalResultText.substring(0, 3500).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const msg = `🚨 <b>Search Alert!</b>\n👤 <b>IP:</b> ${ip}\n🌍 <b>Loc:</b> ${safeCity}, ${safeCountry}\n🏢 <b>ISP:</b> ${safeOrg}\n🔍 <b>Q:</b> ${safeQuery}\n🤖 <b>API:</b> K#${usedKeyIndex} | ${usedModelName}\n\n📝 <b>AI Response:</b>\n<pre>${escapedResult}</pre>`;
      
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: "HTML",
        }),
      }).catch((err) => {});
    }

    return res.status(200).json({ text: finalResultText });
  } finally {
    activeRequests--;
  }
}