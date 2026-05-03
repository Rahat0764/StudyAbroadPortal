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

// Tavily Search 
async function tavilySearch(query, keysString) {
  const keys = keysString.split(",").map((k) => k.trim()).filter(Boolean);
  for (const key of keys) {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          search_depth: "basic",
          max_results: 8, // Increased to get better data on part time jobs/deadlines
          include_answer: true,
          include_raw_content: false,
          search_options: {
             time_range: "year" // Force recent results
          }
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
            content: (x.content || "").slice(0, 800),
          })),
        };
      }
    } catch (e) {
      console.error("Tavily key failed:", e.message);
    }
  }
  return null;
}

export default async function handler(req, res) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  const startMs  = Date.now();

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
  
  // Notice: Frontend now passes a highly optimized natural language query in searchQuery.
  const safeQuery = String(searchQuery || "Unknown").slice(0, 400);

  const logAndReturnError = async (statusCode, clientMsg, tgDetail) => {
    const errorMsg = [
      `🚨 <b>BideshPro API Error (Early Exit)</b>`,
      ``,
      `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
      `🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.country)}`,
      `🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>`,
      `🛑 <b>Status Code:</b> ${statusCode}`,
      `⚠️ <b>Reason:</b> ${esc(tgDetail)}`,
    ].join("\n");
    await tgSend(botToken, chatId, errorMsg);
    return res.status(statusCode).json({ error: clientMsg });
  };

  const origin    = req.headers.origin || "";
  const isAllowed =
    !origin ||
    ALLOWED_ORIGINS.some((o) => origin.includes(o)) ||
    (process.env.NEXT_PUBLIC_SITE_URL && origin === process.env.NEXT_PUBLIC_SITE_URL);

  if (!isAllowed && process.env.NODE_ENV === "production")
    return logAndReturnError(403, "Forbidden origin", `CORS blocked for origin: ${origin}`);

  res.setHeader("Access-Control-Allow-Origin",  origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return logAndReturnError(405, "Method not allowed", `Invalid method: ${req.method}`);

  if (activeRequests >= MAX_CONCURRENT)
    return logAndReturnError(503, "Server too busy. Try again shortly.", "MAX_CONCURRENT reached");

  if (JSON.stringify(req.body || {}).length > 20_000)
    return logAndReturnError(413, "Payload too large", "Request body exceeded 20KB");

  const reqCount = rateLimitMap.get(ip) || 0;
  if (reqCount >= MAX_RPM)
    return logAndReturnError(429, "Too many requests. Please wait a minute.", `Rate limit hit (${reqCount} reqs)`);
  rateLimitMap.set(ip, reqCount + 1);

  if (!prompt || typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000)
    return logAndReturnError(400, "Invalid prompt", `Prompt validation failed. Length: ${prompt?.length || 0}`);

  const mapsUrl = geo.lat && geo.lon
    ? `https://www.google.com/maps?q=${geo.lat},${geo.lon}`
    : null;

  const groqKeysStr = process.env.GROQ_API_KEYS;
  if (!groqKeysStr) return logAndReturnError(500, "Server config error", "GROQ_API_KEYS missing");
  const groqKeys = groqKeysStr.split(",").map((k) => k.trim()).filter(Boolean);
  if (!groqKeys.length) return logAndReturnError(500, "No API keys configured", "GROQ_API_KEYS array is empty");

  const tavilyKeysStr = process.env.TAVILY_API_KEYS || "";

  activeRequests++;

  try {
    let searchContext = "";
    let tavilyStatus  = tavilyKeysStr ? "⏳ pending" : "⏭ skipped (no keys)";

    if (tavilyKeysStr) {
      const tavilyData = await tavilySearch(
        safeQuery !== "Unknown" ? safeQuery : prompt.slice(0, 200),
        tavilyKeysStr
      );
      if (tavilyData) {
        tavilyStatus = `✅ ${tavilyData.results.length} results`;
        const parts  = [];
        if (tavilyData.answer) parts.push(`Web Answer Summary: ${tavilyData.answer}`);
        tavilyData.results.forEach((r, i) => {
          parts.push(`[Source ${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`);
        });
        searchContext = parts.join("\n\n");
      } else {
        tavilyStatus = "❌ all keys failed";
      }
    }

    const currentYear = new Date().getFullYear();
    const enrichedPrompt = searchContext
      ? `${prompt}\n\n${"─".repeat(60)}\n🔍 LIVE GOOGLE SEARCH RESULTS (${currentYear} DATA):\n* Use the context below to provide accurate deadlines, wages, and links for ${currentYear}.\n\n${searchContext}\n${"─".repeat(60)}`
      : prompt;

    const attempts  = [];
    let finalText   = null;
    let usedKeyIdx  = -1;
    let usedModel   = "";

    outer:
    for (let k = 0; k < groqKeys.length; k++) {
      for (const model of GROQ_MODELS) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 28_000);

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
              attempts.push({ key: k + 1, model: model.id, status: "✅ success", detail: "" });
              break outer;
            }
            attempts.push({ key: k + 1, model: model.id, status: "⚠️ empty response", detail: "" });
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
      mapsUrl
        ? `🗺 <a href="${mapsUrl}">View on Google Maps</a> (${geo.lat}, ${geo.lon})`
        : `📍 <b>Coords:</b> N/A`,
      ``,
      `🔍 <b>Tavily Search:</b> ${tavilyStatus}`,
      `🔎 <b>Search Payload:</b> <code>${esc(safeQuery)}</code>`,
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
    ]
      .filter((l) => l !== null)
      .join("\n");

    await tgSend(botToken, chatId, tgMsg);

    if (!finalText) {
      const last = attempts[attempts.length - 1];
      return res.status(500).json({
        error: `All models failed. Last attempt: ${last?.status || "unknown"} — ${last?.detail || "no detail"}`,
      });
    }

    return res.status(200).json({ text: finalText });
  } catch (error) {
    await logAndReturnError(500, "Internal Server Error", error.message);
  } finally {
    activeRequests--;
  }
}