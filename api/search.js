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
];

const ALLOWED_ORIGINS = ["bidesh.pro.bd", "www.bidesh.pro.bd", "vercel.app", "localhost"];

const esc = (s) => String(s).replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");

// Tavily ADVANCED Search 
async function tavilySearch(query, keysString) {
  const keys = keysString.split(",").map((k) => k.trim()).filter(Boolean);
  for (const key of keys) {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000); // 15 seconds for advanced search
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          search_depth: "advanced", // Upgraded to ADVANCED to fetch high-quality & official links
          max_results: 10,
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
            content: (x.content || "").slice(0, 800),
          })),
        };
      }
    } catch (e) { console.error("Tavily key failed:", e.message); }
  }
  return null;
}

export default async function handler(req, res) {
  const startMs  = Date.now();
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const { prompt, searchQuery } = req.body || {};
  const safeQuery = String(searchQuery || "Unknown").slice(0, 400);

  const origin = req.headers.origin || "";
  const isAllowed = !origin || ALLOWED_ORIGINS.some((o) => origin.includes(o)) || (process.env.NEXT_PUBLIC_SITE_URL && origin === process.env.NEXT_PUBLIC_SITE_URL);
  
  if (!isAllowed && process.env.NODE_ENV === "production") return res.status(403).json({ error: "Forbidden origin" });
  res.setHeader("Access-Control-Allow-Origin",  origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (activeRequests >= MAX_CONCURRENT) return res.status(503).json({ error: "Server too busy. Try again shortly." });
  if (JSON.stringify(req.body || {}).length > 20_000) return res.status(413).json({ error: "Payload too large" });

  const reqCount = rateLimitMap.get(ip) || 0;
  if (reqCount >= MAX_RPM) return res.status(429).json({ error: "Too many requests. Please wait a minute." });
  rateLimitMap.set(ip, reqCount + 1);

  if (!prompt || typeof prompt !== "string" || !prompt.trim() || prompt.length > 15000) return res.status(400).json({ error: "Invalid prompt" });

  const groqKeys = (process.env.GROQ_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!groqKeys.length) return res.status(500).json({ error: "Server config error" });

  activeRequests++;

  try {
    const tavilyKeysStr = process.env.TAVILY_API_KEYS || "";
    let searchContext = "";

    if (tavilyKeysStr) {
      const tavilyData = await tavilySearch(safeQuery !== "Unknown" ? safeQuery : prompt.slice(0, 200), tavilyKeysStr);
      if (tavilyData) {
        const parts  = [];
        if (tavilyData.answer) parts.push(`Web Answer Summary: ${tavilyData.answer}`);
        tavilyData.results.forEach((r, i) => parts.push(`[Source ${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`));
        searchContext = parts.join("\n\n");
      }
    }

    const currentYear = new Date().getFullYear();
    const enrichedPrompt = searchContext
      ? `${prompt}\n\n${"─".repeat(60)}\n🔍 ADVANCED WEB SEARCH RESULTS (${currentYear} DATA):\n* Meticulously review the search results below to extract precise quotas, wages, and OFFICIAL domains (e.g. .gov, .edu).\n\n${searchContext}\n${"─".repeat(60)}`
      : prompt;

    let finalText = null;

    outer:
    for (let k = 0; k < groqKeys.length; k++) {
      for (const model of GROQ_MODELS) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 35_000); // 35s for Groq long detailed response

        try {
          const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKeys[k]}` },
            body: JSON.stringify({
              model:       model.id,
              messages:    [{ role: "user", content: enrichedPrompt }],
              max_tokens:  5000, // Increased for highly detailed responses
              temperature: 0.65,
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);

          if (r.ok) {
            const d = await r.json();
            const text = d.choices?.[0]?.message?.content;
            if (text) { finalText = text; break outer; }
          }
        } catch (err) { clearTimeout(timer); }
      }
    }

    if (!finalText) return res.status(500).json({ error: "All AI models failed or timed out. Please try again." });
    return res.status(200).json({ text: finalText });
  } catch (error) {
    return res.status(500).json({ error: "Internal Server Error" });
  } finally { activeRequests--; }
}