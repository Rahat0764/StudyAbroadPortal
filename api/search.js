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
  } catch (e) {
    console.error("Telegram send failed:", e);
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
    return await r.json();
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
            attempts.push({ key: k + 1, model, status: "✅ success", detail: "" });
            return { text, attempts };
          }
          attempts.push({ key: k + 1, model, status: "⚠️ empty response", detail: "" });
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

export default async function handler(req, res) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const startMs = Date.now();

  const ip =
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const { prompt, locationData, searchQuery, tavilyQuery } = req.body || {};

  const geo = {
    city: String(locationData?.city || "Unknown").slice(0, 60),
    region: String(locationData?.region || "Unknown").slice(0, 60),
    country: String(locationData?.country || "Unknown").slice(0, 60),
    countryCode: String(locationData?.countryCode || "??").slice(0, 4),
    org: String(locationData?.org || "Unknown").slice(0, 120),
    timezone: String(locationData?.timezone || "Unknown").slice(0, 60),
    postal: String(locationData?.postal || "Unknown").slice(0, 20),
    lat: parseFloat(locationData?.latitude) || null,
    lon: parseFloat(locationData?.longitude) || null,
  };
  const safeQuery = String(searchQuery || "Unknown").slice(0, 400);
  const mapsUrl =
    geo.lat && geo.lon
      ? `https://www.google.com/maps?q=${geo.lat},${geo.lon}`
      : null;

  const logAndReturnError = async (statusCode, clientMsg, tgDetail) => {
    const errorMsg = [
      `🚨 <b>BideshPro API Error</b>`,
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

  const origin = req.headers.origin || "";
  const isAllowed =
    !origin ||
    ALLOWED_ORIGINS.some((o) => origin.includes(o)) ||
    (process.env.NEXT_PUBLIC_SITE_URL && origin === process.env.NEXT_PUBLIC_SITE_URL);

  if (!isAllowed && process.env.NODE_ENV === "production")
    return logAndReturnError(403, "Forbidden origin", `CORS blocked: ${origin}`);

  res.setHeader("Access-Control-Allow-Origin", origin || "*");
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

  const groqKeys = (process.env.GROQ_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!groqKeys.length)
    return logAndReturnError(500, "Server config error", "GROQ_API_KEYS missing");

  const tavilyKeys = (process.env.TAVILY_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  activeRequests++;

  try {
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
4. NEVER fabricate URLs. If you cannot confirm a URL from search results, use the main domain only.
5. GPA must be mentioned as both out of 5.0 (SSC/HSC) and out of 4.0 (CGPA).
6. Include Bangladesh-specific quota seats where available.
7. Stipends and costs in local currency AND approximate BDT.`;

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
      const preview =
        esc(finalText.slice(0, 1500)) + (finalText.length > 1500 ? "\n[... truncated]" : "");
      const tgMsg = [
        `🔍 <b>BideshPro — New AI Query</b>`,
        ``,
        `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
        `🏙 <b>Geo:</b> ${esc(geo.city)}, ${esc(geo.region)}, ${esc(geo.country)} (${esc(geo.countryCode)})`,
        `🏢 <b>Org:</b> ${esc(geo.org)}`,
        `🕐 <b>Timezone:</b> ${esc(geo.timezone)} | <b>Postal:</b> ${esc(geo.postal)}`,
        mapsUrl ? `🗺 <a href="${mapsUrl}">View on Google Maps</a>` : `📍 <b>Coords:</b> N/A`,
        ``,
        `🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>`,
        `🌐 <b>Tavily:</b> ${tavilyUsed ? "✅ used" : "⏭ skipped (no key or query)"}`,
        `⏱ <b>Response time:</b> ${elapsed}s`,
        ``,
        `🤖 <b>Groq Attempts (${attempts.length}):</b>`,
        attemptLines || "(none recorded)",
        ``,
        `✅ <b>SUCCESS</b>`,
        ``,
        `📝 <b>Preview:</b>`,
        `<pre>${preview}</pre>`,
      ]
        .filter((l) => l !== null)
        .join("\n");

      await tgSend(botToken, chatId, tgMsg);
      return res.status(200).json({ text: finalText });
    } else {
      const failMsg = [
        `❌ <b>All Models Failed (${elapsed}s)</b>`,
        ``,
        `👤 <b>IP:</b> <code>${esc(ip)}</code>`,
        `🔎 <b>Query:</b> <code>${esc(safeQuery)}</code>`,
        ``,
        `🤖 <b>Attempts:</b>`,
        attemptLines || "(none)",
      ].join("\n");
      await tgSend(botToken, chatId, failMsg);
      return res.status(500).json({
        error: "All AI models are currently busy. Please try again in a moment.",
      });
    }
  } catch (error) {
    await logAndReturnError(500, "Internal Server Error", error.message);
  } finally {
    activeRequests--;
  }
}