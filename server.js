const express = require("express");

const app = express();
app.use(express.json({ limit: "50mb" }));

// CONFIG
const PORT = process.env.PORT || 10000;

const rateLimitMap = new Map();
let activeRequests = 0;
const MAX_CONCURRENT = 20;
const MAX_RPM = 15;

setInterval(() => rateLimitMap.clear(), 60_000);

// Groq models
const GROQ_MODELS = [
  { id: "llama-3.3-70b-versatile"  },
  { id: "llama-3.1-70b-versatile"  },
  { id: "mixtral-8x7b-32768"       },
  { id: "llama-3.1-8b-instant"     },
  { id: "gemma2-9b-it"             },
];

const ALLOWED_ORIGINS = [
  "vercel.app",
  "localhost",
  "bidesh.pro.bd",
  "www.bidesh.pro.bd",
];

// HELPERS
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
  } catch (e) {
    console.error("Telegram error:", e);
  }
}

// Tavily Search — tries each key in turn
async function tavilySearch(query, keysString) {
  const keys = keysString.split(",").map((k) => k.trim()).filter(Boolean);
  for (const key of keys) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          search_depth: "basic",
          max_results: 6,
          include_answer: true,
          include_raw_content: false,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        return {
          answer:  d.answer || "",
          results: (d.results || []).map((x) => ({
            title:   x.title   || "",
            url:     x.url     || "",
            content: (x.content || "").slice(0, 600),
          })),
        };
      }
    } catch (e) {
      console.error("Tavily key failed:", e.message);
    }
  }
  return null;
}

// CORS
app.use((req, res, next) => {
  const origin  = req.headers.origin || "";
  const allowed = !origin || ALLOWED_ORIGINS.some((o) => origin.includes(o));
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin",  origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// HEALTH CHECK
app.get("/", (_req, res) =>
  res.status(200).send("✅ BideshPro Backend is Awake and Running!")
);

// MAIN ROUTE
app.post("/api/search", async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  const startMs  = Date.now();

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
  const { prompt, locationData, searchQuery } = req.body || {};
  const safeQuery = String(searchQuery || "Unknown").slice(0, 400);

  const geo = {
    city:        String(locationData?.city        || "Unknown").slice(0, 60),
    region:      String(locationData?.region      || "Unknown").slice(0, 60),
    country:     String(locationData?.country     || "Unknown").slice(0, 60),
    countryCode: String(locationData?.countryCode || "??").slice(0, 4),
    org:         String(locationData?.org         || "Unknown").slice(0, 120),
    lat:         parseFloat(locationData?.latitude)  || null,
    lon:         parseFloat(locationData?.longitude) || null,
  };
  const mapsUrl = geo.lat && geo.lon
    ? `https://www.google.com/maps?q=${geo.lat},${geo.lon}`
    : null;

  const logAndReturnError = async (statusCode, clientMsg, tgDetail) => {
    const msg = `🚨 <b>BideshPro API Error</b>\n\n👤 <b>IP:</b> <code>${esc(ip)}</code>\n🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.country)}\n🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>\n🛑 <b>Status:</b> ${statusCode}\n⚠️ <b>Reason:</b> ${esc(tgDetail)}`;
    await tgSend(botToken, chatId, msg);
    return res.status(statusCode).json({ error: clientMsg });
  };

  try {
    if (!prompt || prompt.length > 12000)
      return logAndReturnError(400, "Invalid prompt", "Prompt missing or too long (>12000 chars)");

    if (activeRequests >= MAX_CONCURRENT)
      return logAndReturnError(503, "Server busy. Try again.", "MAX_CONCURRENT reached");

    const reqCount = rateLimitMap.get(ip) || 0;
    if (reqCount >= MAX_RPM)
      return logAndReturnError(429, "Too many requests. Wait a minute.", `Rate limit hit (${reqCount} reqs)`);

    rateLimitMap.set(ip, reqCount + 1);

    const groqKeys = (process.env.GROQ_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
    if (!groqKeys.length)
      return logAndReturnError(500, "Server Configuration Error", "No GROQ_API_KEYS configured");

    const tavilyKeysStr = process.env.TAVILY_API_KEYS || "";

    activeRequests++;

    let searchContext = "";
    let tavilyStatus  = tavilyKeysStr ? "⏳ pending" : "⏭ skipped (no keys)";

    if (tavilyKeysStr) {
      const tavilyData = await tavilySearch(
        safeQuery !== "Unknown" ? safeQuery : prompt.slice(0, 200),
        tavilyKeysStr
      );
      if (tavilyData) {
        tavilyStatus = `✅ ${tavilyData.results.length} results`;
        const parts = [];
        if (tavilyData.answer) parts.push(`Web Answer Summary: ${tavilyData.answer}`);
        tavilyData.results.forEach((r, i) => {
          parts.push(`[Source ${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`);
        });
        searchContext = parts.join("\n\n");
      } else {
        tavilyStatus = "❌ all keys failed";
      }
    }

    // Enrich the user prompt with live search data
    const enrichedPrompt = searchContext
      ? `${prompt}\n\n${"─".repeat(60)}\n🔍 REAL-TIME WEB SEARCH RESULTS (Tavily — use these as authoritative sources for current deadlines, links, and data):\n\n${searchContext}\n${"─".repeat(60)}`
      : prompt;

    const attempts  = [];
    let finalText   = null;
    let usedKeyIdx  = -1;
    let usedModel   = "";

    outer:
    for (let k = 0; k < groqKeys.length; k++) {
      for (const model of GROQ_MODELS) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30_000);

        try {
          const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type":  "application/json",
              "Authorization": `Bearer ${groqKeys[k]}`,
            },
            body: JSON.stringify({
              model:       model.id,
              messages:    [{ role: "user", content: enrichedPrompt }],
              max_tokens:  4096,
              temperature: 0.65,
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);

          if (r.ok) {
            const d    = await r.json();
            const text = d.choices?.[0]?.message?.content;
            if (text) {
              finalText  = text;
              usedKeyIdx = k + 1;
              usedModel  = model.id;
              attempts.push({ key: k + 1, model: model.id, status: "✅ success" });
              break outer;
            }
            attempts.push({ key: k + 1, model: model.id, status: "⚠️ empty response" });
          } else {
            const errBody = await r.json().catch(() => ({}));
            const errMsg  = errBody?.error?.message || `HTTP ${r.status}`;
            const isQuota = r.status === 429 || /quota|rate.?limit|exceeded/i.test(errMsg);
            attempts.push({
              key:    k + 1,
              model:  model.id,
              status: isQuota ? "⏭ quota/rate-limit" : `❌ HTTP ${r.status}`,
              detail: errMsg.slice(0, 120),
            });
          }
        } catch (err) {
          clearTimeout(timer);
          attempts.push({
            key:    k + 1,
            model:  model.id,
            status: err.name === "AbortError" ? "⏱ timeout (30s)" : "❌ exception",
            detail: err.name === "AbortError" ? "" : err.message.slice(0, 80),
          });
        }
      }
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const attemptLines = attempts
      .map((a) =>
        `${a.status} — Key#${a.key} | <code>${esc(a.model)}</code>${a.detail ? `\n    └ <i>${esc(a.detail.slice(0, 100))}</i>` : ""}`
      )
      .join("\n");

    if (finalText) {
      const preview = finalText.slice(0, 1000) + (finalText.length > 1000 ? "\n[... truncated]" : "");
      const successMsg = [
        `✅ <b>Success (${elapsed}s)</b>`,
        ``,
        `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
        `🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.country)}`,
        `🏢 <b>ISP:</b> ${esc(geo.org)}`,
        mapsUrl ? `🗺 <a href="${mapsUrl}">View Maps</a>` : null,
        `🔍 <b>Tavily:</b> ${tavilyStatus}`,
        `🤖 <b>Model:</b> <code>${esc(usedModel)}</code> (Key#${usedKeyIdx})`,
        `🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>`,
        ``,
        `📝 <b>Preview:</b>`,
        `<pre>${esc(preview)}</pre>`,
      ].filter(Boolean).join("\n");
      await tgSend(botToken, chatId, successMsg);
      return res.json({ text: finalText });
    } else {
      const failMsg = [
        `❌ <b>All Models Failed (${elapsed}s)</b>`,
        ``,
        `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
        `🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>`,
        `🔍 <b>Tavily:</b> ${tavilyStatus}`,
        ``,
        `🤖 <b>Attempts:</b>`,
        attemptLines,
      ].join("\n");
      await tgSend(botToken, chatId, failMsg);
      return res.status(500).json({ error: "All AI models are currently busy or failed. Please try again." });
    }
  } catch (globalError) {
    await logAndReturnError(500, "Internal Server Error", globalError.message);
  } finally {
    activeRequests--;
  }
});

// START
app.listen(PORT, () => console.log(`Render Backend is running on port ${PORT}`));