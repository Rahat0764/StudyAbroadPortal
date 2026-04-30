const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;

const rateLimitMap = new Map();
let activeRequests = 0;
const MAX_CONCURRENT = 20;
const MAX_RPM = 15;

setInterval(() => rateLimitMap.clear(), 60_000);

const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-70b-versatile",
  "gemma2-9b-it",
];

const ALLOWED_ORIGINS = [
  "vercel.app",
  "localhost",
  "bidesh.pro.bd",
  "www.bidesh.pro.bd",
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
  } catch (e) {
    console.error("Telegram error:", e);
  }
}

async function tavilySearch(query, tavilyKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: "advanced",
        include_answer: true,
        max_results: 8,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    return d;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function groqGenerate(systemPrompt, userPrompt, groqKeys) {
  const attempts = [];
  for (let k = 0; k < groqKeys.length; k++) {
    for (const model of GROQ_MODELS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${groqKeys[k]}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.5,
            max_tokens: 4096,
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (r.ok) {
          const d = await r.json();
          const text = d.choices?.[0]?.message?.content;
          if (text) {
            attempts.push({ key: k + 1, model, status: "✅ success" });
            return { text, attempts };
          }
          attempts.push({ key: k + 1, model, status: "⚠️ empty response" });
        } else {
          const errBody = await r.json().catch(() => ({}));
          const errMsg = errBody?.error?.message || `HTTP ${r.status}`;
          const isQuota = r.status === 429;
          attempts.push({
            key: k + 1,
            model,
            status: isQuota ? "⏭ rate-limit" : `❌ HTTP ${r.status}`,
            detail: errMsg.slice(0, 120),
          });
          if (isQuota) continue;
          if (r.status === 401 || r.status === 403) break;
        }
      } catch (err) {
        clearTimeout(timer);
        attempts.push({
          key: k + 1,
          model,
          status: err.name === "AbortError" ? "⏱ timeout (25s)" : "❌ exception",
          detail: err.name === "AbortError" ? "" : err.message.slice(0, 80),
        });
      }
    }
  }
  return { text: null, attempts };
}

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

app.get("/", (req, res) => {
  res.status(200).send("✅ BideshPro Backend is Awake and Running!");
});

app.post("/api/search", async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const startMs = Date.now();

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    "unknown";

  const { prompt, locationData, searchQuery, tavilyQuery } = req.body || {};
  const safeQuery = String(searchQuery || "Unknown").slice(0, 400);

  const geo = {
    city: String(locationData?.city || "Unknown").slice(0, 60),
    region: String(locationData?.region || "Unknown").slice(0, 60),
    country: String(locationData?.country || "Unknown").slice(0, 60),
    countryCode: String(locationData?.countryCode || "??").slice(0, 4),
    org: String(locationData?.org || "Unknown").slice(0, 120),
    lat: parseFloat(locationData?.latitude) || null,
    lon: parseFloat(locationData?.longitude) || null,
  };
  const mapsUrl =
    geo.lat && geo.lon
      ? `https://www.google.com/maps?q=${geo.lat},${geo.lon}`
      : null;

  const logAndReturnError = async (statusCode, clientMsg, tgDetail) => {
    const errorMsg = `🚨 <b>BideshPro API Error</b>\n\n👤 <b>IP:</b> <code>${esc(ip)}</code>\n🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.country)}\n🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>\n🛑 <b>Status:</b> ${statusCode}\n⚠️ <b>Reason:</b> ${esc(tgDetail)}`;
    await tgSend(botToken, chatId, errorMsg);
    return res.status(statusCode).json({ error: clientMsg });
  };

  try {
    if (!prompt || prompt.length > 12000)
      return logAndReturnError(400, "Invalid prompt", `Prompt validation failed. Length: ${prompt?.length || 0}`);

    if (activeRequests >= MAX_CONCURRENT)
      return logAndReturnError(503, "Server busy. Try again.", "MAX_CONCURRENT reached");

    const reqCount = rateLimitMap.get(ip) || 0;
    if (reqCount >= MAX_RPM)
      return logAndReturnError(429, "Too many requests. Wait a minute.", `Rate limit hit (${reqCount} reqs)`);

    rateLimitMap.set(ip, reqCount + 1);

    const groqKeys = (process.env.GROQ_API_KEYS || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (!groqKeys.length)
      return logAndReturnError(500, "Server configuration error", "GROQ_API_KEYS missing");

    const tavilyKeys = (process.env.TAVILY_API_KEYS || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    activeRequests++;

    let searchContext = "";
    let tavilyUsed = false;

    if (tavilyKeys.length && tavilyQuery) {
      const tvKey = tavilyKeys[Math.floor(Math.random() * tavilyKeys.length)];
      const tvResult = await tavilySearch(tavilyQuery, tvKey);
      if (tvResult) {
        tavilyUsed = true;
        const snippets = (tvResult.results || [])
          .slice(0, 6)
          .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content?.slice(0, 400)}`)
          .join("\n\n");
        const answer = tvResult.answer ? `Summary: ${tvResult.answer}\n\n` : "";
        searchContext = `REAL-TIME WEB SEARCH RESULTS (use these as your primary source):\n${answer}${snippets}`;
      }
    }

    const systemPrompt = `You are a highly experienced international scholarship consultant for Bangladeshi students. Your responses must be detailed, accurate, and formatted in clear Markdown.

CRITICAL RULES:
1. Use the provided web search results as your PRIMARY source of truth.
2. Always mention the CURRENT academic year and cycle.
3. For deadlines, use exact dates. If unknown, state "(Based on last year's cycle — verify officially)".
4. NEVER fabricate URLs. If you cannot confirm a URL from search results, use the main domain only (e.g., https://www.harvard.edu).
5. GPA should be mentioned as both out of 5.0 (SSC/HSC) and out of 4.0 (CGPA).
6. Include Bangladesh-specific quota seats where available.
7. Stipends and costs must be in local currency AND approximate BDT.`;

    const userPrompt = searchContext
      ? `${searchContext}\n\n---\n\nNow answer the following using the search results above:\n\n${prompt}`
      : prompt;

    const { text: finalText, attempts } = await groqGenerate(systemPrompt, userPrompt, groqKeys);

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

    const attemptLines = attempts
      .map(
        (a) =>
          `${a.status} — Key#${a.key} | <code>${esc(a.model)}</code>${a.detail ? `\n    └ <i>${esc(a.detail)}</i>` : ""}`
      )
      .join("\n");

    if (finalText) {
      const preview = esc(finalText.slice(0, 1000)) + (finalText.length > 1000 ? "\n[... truncated]" : "");
      const successMsg = [
        `✅ <b>BideshPro — Success (${elapsed}s)</b>`,
        ``,
        `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
        `🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.country)}`,
        `🏢 <b>ISP:</b> ${esc(geo.org)}`,
        mapsUrl ? `🗺 <a href="${mapsUrl}">View Maps</a>` : null,
        `🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>`,
        `🌐 <b>Tavily:</b> ${tavilyUsed ? "✅ used" : "⏭ skipped"}`,
        ``,
        `🤖 <b>Groq Attempts:</b>`,
        attemptLines,
        ``,
        `📝 <b>Preview:</b>`,
        `<pre>${preview}</pre>`,
      ]
        .filter((l) => l !== null)
        .join("\n");
      await tgSend(botToken, chatId, successMsg);
      return res.json({ text: finalText });
    } else {
      const failMsg = [
        `❌ <b>All Models Failed (${elapsed}s)</b>`,
        ``,
        `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
        `🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>`,
        ``,
        `🤖 <b>Attempts (${attempts.length}):</b>`,
        attemptLines || "(none)",
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

app.listen(PORT, () => {
  console.log(`BideshPro Backend running on port ${PORT}`);
});