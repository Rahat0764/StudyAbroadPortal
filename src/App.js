// Main
import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signInWithCustomToken,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  onSnapshot,
  updateDoc,
  increment,
} from "firebase/firestore";

const VIEWS = { COUNTRIES: "countries", SEARCH: "search", RESULT: "result" };
const CACHE_LIMIT = 25;

// Firebase
let app, auth, db, appId;
try {
  const firebaseConfig =
    typeof __firebase_config !== "undefined" ? JSON.parse(__firebase_config) : null;
  appId =
    typeof __app_id !== "undefined" ? String(__app_id) : "bideshpro-default";
  if (firebaseConfig) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  }
} catch (_) {}

// Error Boundary
class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err, info) { console.error("ErrorBoundary:", err, info); }
  render() {
    if (this.state.hasError)
      return (
        <div className="min-h-screen bg-[#03050a] flex items-center justify-center text-center p-10">
          <div>
            <div className="text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-bold text-white mb-2">Something went wrong</h2>
            <p className="text-[#7a94ad] mb-4">Please refresh the page.</p>
            <button onClick={() => window.location.reload()} className="bg-[#4a9eff] text-white font-bold px-6 py-2 rounded-xl">
              Refresh
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

// Hooks
function useDebounce(value, delay) {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDv(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return dv;
}

function useOfflineStatus() {
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return offline;
}

// Services
const CacheService = {
  _map: new Map(),
  set(key, val) {
    if (this._map.size >= CACHE_LIMIT) this._map.delete(this._map.keys().next().value);
    this._map.set(key.toLowerCase().trim(), val);
  },
  get(key) { return this._map.get(key.toLowerCase().trim()); },
};

// API Call
const ApiService = {
  async fetch(url, opts, retries = 2) {
    for (let i = 0; i < retries; i++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 120_000); // 120s for advanced deep search
        const r = await fetch(url, { ...opts, signal: ctrl.signal });
        clearTimeout(t);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Server error");
        return data.text;
      } catch (err) {
        if (err.name === "AbortError") throw new Error("Request timed out. Advanced AI search is taking longer than expected.");
        if (i === retries - 1) throw err;
        await new Promise((res) => setTimeout(res, 1200 * (i + 1)));
      }
    }
  },
};

// IP Geolocation
async function fetchUserIPDetails() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch("https://ipapi.co/json/", { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    return {
      ip:          d.ip           || "Unknown",
      city:        d.city         || "Unknown",
      country:     d.country_name || "Unknown",
      countryCode: d.country_code || "??",
    };
  } catch {
    return { ip:"Unknown", city:"Unknown", country:"Unknown", countryCode:"??" };
  }
}

// Clipboard
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    return true;
  } catch { return false; }
}

// Markdown Renderer
function MarkdownRenderer({ text }) {
  if (!text) return null;

  const escHtml = (s) => s.replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  const sanitizeUrl = (url) => { const u = url.trim().replace(/['"]/g, ""); return /^(javascript|data):/i.test(u) ? "#" : u; };

  const parseInline = (raw) => {
    let h = escHtml(raw);
    h = h.replace(/\*\*(.+?)\*\*/g, `<strong class="text-white font-bold theme-text-strong">$1</strong>`);
    h = h.replace(/\*(.+?)\*/g, `<em class="text-[#4a9eff] not-italic font-semibold theme-text-accent">$1</em>`);
    h = h.replace(/`([^`]+)`/g, `<code class="bg-[#1a2a3a] text-[#2ecc8a] px-1.5 py-0.5 rounded text-xs font-mono theme-code">$1</code>`);
    h = h.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, title, url) => `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" class="text-[#4a9eff] underline underline-offset-2 hover:text-[#2ecc8a] font-medium break-all theme-link" title="${escHtml(url)}">🔗 ${escHtml(title)}</a>`
    );
    return h;
  };

  const lines = text.split("\n");
  const els = [];
  let ulItems = [], olItems = [];

  const flushLists = () => {
    if (ulItems.length) { els.push(<ul key={`ul-${els.length}`} className="list-none mb-5 space-y-2 text-[#8faabb] theme-text-muted">{ulItems}</ul>); ulItems = []; }
    if (olItems.length) { els.push(<ol key={`ol-${els.length}`} className="list-none mb-5 space-y-2 text-[#8faabb] theme-text-muted">{olItems}</ol>); olItems = []; }
  };

  lines.forEach((line, idx) => {
    const tr = line.trim();

    if (tr.startsWith("|")) {
      flushLists();
      if (tr.replace(/[\s|:-]/g, "").length === 0) return;
      const cells = tr.split("|").filter(Boolean).map((c) => c.trim());
      const isHeader = idx === 0 || (lines[idx - 1]?.trim() === "" && !lines[idx - 2]?.trim().startsWith("|"));
      els.push(
        <div key={`tr-${idx}`} className={`flex gap-0 ${isHeader ? "border-b-2 border-[#1e3045] bg-[#141f2e]/50 theme-table-header" : "border-b border-[#141f2e]/50 theme-table-row"} mb-0`}>
          {cells.map((c, ci) => (
            <div key={ci} className={`flex-1 px-4 py-2.5 text-sm ${isHeader ? "text-white font-bold theme-text-strong" : "text-[#8faabb] theme-text-muted"}`} dangerouslySetInnerHTML={{ __html: parseInline(c) }} />
          ))}
        </div>
      );
      return;
    }

    if (/^[-*•]\s/.test(tr)) {
      flushLists(); // Only flush ordered lists
      const content = tr.replace(/^[-*•]\s/, "");
      ulItems.push(
        <li key={`li-${idx}`} className="flex gap-2.5 items-start pl-2 leading-relaxed">
          <span className="text-[#4a9eff] mt-1 text-[10px] flex-shrink-0 theme-bullet">▶</span>
          <span dangerouslySetInnerHTML={{ __html: parseInline(content) }} />
        </li>
      );
      return;
    }

    if (/^\d+[.)]\s/.test(tr)) {
      flushLists();
      const num = tr.match(/^(\d+)/)[1];
      const content = tr.replace(/^\d+[.)]\s/, "");
      olItems.push(
        <li key={`li-${idx}`} className="flex gap-2 items-start pl-2 leading-relaxed">
          <span className="text-[#2ecc8a] font-bold text-sm flex-shrink-0 min-w-[20px] theme-bullet-num">{num}.</span>
          <span dangerouslySetInnerHTML={{ __html: parseInline(content) }} />
        </li>
      );
      return;
    }

    flushLists();
    if (!tr) { els.push(<div key={`sp-${idx}`} className="h-3" />); return; }

    if (tr.startsWith("# ")) els.push(<h1 key={`h1-${idx}`} className="text-3xl font-extrabold text-white mt-8 mb-5 theme-text-heading" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(2)) }} />);
    else if (tr.startsWith("## ")) els.push(<h2 key={`h2-${idx}`} className="text-2xl font-bold text-white mt-10 mb-5 bg-[#141f2e] px-5 py-3 rounded-xl border-l-4 border-[#4a9eff] theme-h2" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(3)) }} />);
    else if (tr.startsWith("### ")) els.push(<h3 key={`h3-${idx}`} className="text-xl font-bold text-[#dde6f0] mt-8 mb-3 pb-2 border-b border-[#141f2e] theme-h3" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(4)) }} />);
    else if (tr.startsWith("#### ")) els.push(<h4 key={`h4-${idx}`} className="text-lg font-semibold text-[#4a9eff] mt-6 mb-2 theme-h4" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(5)) }} />);
    else if (tr.startsWith("---") || tr.startsWith("___")) els.push(<hr key={`hr-${idx}`} className="border-[#1e3045] my-6 theme-hr" />);
    else if (tr.startsWith("> ")) els.push(<blockquote key={`bq-${idx}`} className="border-l-4 border-[#2ecc8a] bg-[#0c1520] px-5 py-3 rounded-r-lg my-4 text-[#8faabb] italic text-sm theme-blockquote" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(2)) }} />);
    else els.push(<p key={`p-${idx}`} className="text-[#8faabb] leading-relaxed mb-3 text-[15px] theme-text-body" dangerouslySetInnerHTML={{ __html: parseInline(tr) }} />);
  });

  flushLists();
  return <div className="space-y-1 font-sans">{els}</div>;
}

// Skeleton Loader
function SkeletonLoader() {
  return (
    <div className="animate-pulse space-y-6 pt-4 text-left">
      <div className="h-10 bg-[#141f2e] theme-skeleton rounded-xl w-3/4" />
      <div className="space-y-3">
        {[100, 85, 95, 75, 90].map((w, i) => (
          <div key={i} style={{ width: `${w}%` }} className="h-4 bg-[#141f2e] theme-skeleton rounded" />
        ))}
      </div>
      <div className="h-8 bg-[#141f2e] theme-skeleton rounded-xl w-1/2 mt-6" />
      <div className="space-y-3">
        {[80, 95, 70].map((w, i) => (
          <div key={i} style={{ width: `${w}%` }} className="h-4 bg-[#141f2e] theme-skeleton rounded" />
        ))}
      </div>
    </div>
  );
}

// Light Mode CSS Injection (Bulletproof)
const LIGHT_MODE_CSS = `
  .theme-light { background-color: #f0f4f8 !important; color: #1e293b !important; }
  .theme-light .bg-\\[\\#03050a\\] { background-color: #f0f4f8 !important; }
  .theme-light .bg-\\[\\#070b12\\] { background-color: #ffffff !important; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05) !important; }
  .theme-light .bg-\\[\\#0b1119\\] { background-color: #f8fafc !important; }
  .theme-light .bg-\\[\\#141f2e\\] { background-color: #e2e8f0 !important; }
  .theme-light .bg-\\[\\#1a2a3a\\] { background-color: #cbd5e1 !important; }
  .theme-light header { background-color: rgba(255,255,255,0.95) !important; border-bottom-color: #e2e8f0 !important; }
  .theme-light footer { background-color: #f8fafc !important; border-top-color: #e2e8f0 !important; }
  
  /* Text Overrides */
  .theme-light .text-white, .theme-light .theme-text-heading, .theme-light .theme-text-strong { color: #0f172a !important; }
  .theme-light .text-\\[\\#dde6f0\\], .theme-light .text-\\[\\#8faabb\\] { color: #334155 !important; }
  .theme-light .text-\\[\\#7a94ad\\], .theme-light .theme-text-muted, .theme-light .theme-text-body { color: #475569 !important; }
  .theme-light .text-\\[\\#3d5269\\] { color: #64748b !important; }
  
  /* Borders & Highlights */
  .theme-light .border-\\[\\#141f2e\\], .theme-light .border-\\[\\#1e3045\\] { border-color: #cbd5e1 !important; }
  .theme-light .theme-hr { border-color: #e2e8f0 !important; }
  .theme-light .theme-h2 { background-color: #f1f5f9 !important; border-left-color: #3b82f6 !important; }
  .theme-light .theme-h3 { border-bottom-color: #e2e8f0 !important; color: #1e293b !important; }
  .theme-light .theme-table-header { background-color: #f1f5f9 !important; border-bottom-color: #cbd5e1 !important; }
  .theme-light .theme-table-row { border-bottom-color: #e2e8f0 !important; }
  .theme-light .theme-blockquote { background-color: #f0fdf4 !important; border-left-color: #10b981 !important; color: #0f172a !important; }
  .theme-light .theme-skeleton { background-color: #e2e8f0 !important; }
  
  /* Accents */
  .theme-light .text-\\[\\#4a9eff\\] { color: #2563eb !important; }
  .theme-light .text-\\[\\#2ecc8a\\] { color: #059669 !important; }
  .theme-light .bg-\\[\\#4a9eff\\] { background-color: #3b82f6 !important; color: #ffffff !important; }
  .theme-light .hover\\:bg-\\[\\#141f2e\\]:hover { background-color: #e2e8f0 !important; }
`;

// Countries
const COUNTRIES = [
  { name: "United States",   flag: "🇺🇸", hint: "Fulbright, Assistantships, OPT" },
  { name: "United Kingdom",  flag: "🇬🇧", hint: "Chevening, Commonwealth, Gates" },
  { name: "Canada",          flag: "🇨🇦", hint: "Vanier, McCall MacBain, IDRC" },
  { name: "Australia",       flag: "🇦🇺", hint: "Australia Awards, RTP" },
  { name: "Germany",         flag: "🇩🇪", hint: "DAAD, Free Tuition, EU" },
  { name: "Italy",           flag: "🇮🇹", hint: "DSU, MAECI, Invest Your Talent" },
  { name: "Saudi Arabia",    flag: "🇸🇦", hint: "Saudi Govt 500 Quota, King Abdullah" },
  { name: "South Korea",     flag: "🇰🇷", hint: "GKS/KGSP, POSTECH, KAIST" },
  { name: "Japan",           flag: "🇯🇵", hint: "MEXT, JASSO, JICA" },
  { name: "China",           flag: "🇨🇳", hint: "CSC, Confucius, Provincial" },
  { name: "Malaysia",        flag: "🇲🇾", hint: "MIS, MIGeM, UM" },
  { name: "Sweden",          flag: "🇸🇪", hint: "SI Scholarship, Free Tuition" },
  { name: "France",          flag: "🇫🇷", hint: "Eiffel, Campus France" },
  { name: "Netherlands",     flag: "🇳🇱", hint: "Holland Scholarship" },
  { name: "Turkey",          flag: "🇹🇷", hint: "Türkiye Burslari, YTB" },
];

function MainApp() {
  const [view, setView]                     = useState(VIEWS.COUNTRIES);
  const [language, setLanguage]             = useState("Bengali");
  const [userAuth, setUserAuth]             = useState(null);
  const [userInfo, setUserInfo]             = useState(null);
  const isOffline                           = useOfflineStatus();
  
  const [isDark, setIsDark]                 = useState(() => {
    try { const saved = localStorage.getItem("bideshpro_theme"); return saved ? saved === "dark" : true; } catch { return true; }
  });

  const [selectedCountry, setSelectedCountry] = useState(null);
  const [level, setLevel]                   = useState("all");
  const [background, setBackground]         = useState("all");
  const [countrySearch, setCountrySearch]   = useState("");
  const debouncedSearch                     = useDebounce(countrySearch, 280);

  const [resultText, setResultText]         = useState(null);
  const [loading, setLoading]               = useState(false);
  const [isSlowLoading, setIsSlowLoading]   = useState(false);
  const [error, setError]                   = useState(null);
  const [copied, setCopied]                 = useState(false);

  const [globalQ, setGlobalQ]               = useState("");
  const [globalResult, setGlobalResult]     = useState(null);
  const [history, setHistory]               = useState([]);

  const resultRef = useRef(null);
  const PERSIST_KEY = "bideshpro_last_result";

  // Session & Theme
  useEffect(() => {
    try {
      const s = sessionStorage.getItem("bideshpro_state");
      if (s) { const d = JSON.parse(s); if (d.view) setView(d.view); if (d.selectedCountry) setSelectedCountry(d.selectedCountry); if (d.level) setLevel(d.level); if (d.background) setBackground(d.background); if (d.language) setLanguage(d.language); }
      const saved = localStorage.getItem(PERSIST_KEY);
      if (saved) { const parsed = JSON.parse(saved); if (parsed.resultText) setResultText(parsed.resultText); if (parsed.globalResult) setGlobalResult(parsed.globalResult); }
      const h = localStorage.getItem("bideshpro_history"); if (h) setHistory(JSON.parse(h));
    } catch (_) {}
  }, []);

  useEffect(() => { try { sessionStorage.setItem("bideshpro_state", JSON.stringify({ view, selectedCountry, level, background, language })); } catch (_) {} }, [view, selectedCountry, level, background, language]);
  useEffect(() => { try { localStorage.setItem("bideshpro_theme", isDark ? "dark" : "light"); } catch (_) {} }, [isDark]);

  useEffect(() => {
    if (!auth) return;
    const init = async () => { try { await signInAnonymously(auth); } catch (_) {} };
    init(); return onAuthStateChanged(auth, setUserAuth);
  }, []);

  useEffect(() => { fetchUserIPDetails().then(setUserInfo); }, []);
  useEffect(() => { if (resultText && resultRef.current) resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" }); }, [resultText]);

  const saveHistory = useCallback((q) => {
    setHistory((prev) => {
      const updated = [q, ...prev.filter((x) => x !== q)].slice(0, 6);
      try { localStorage.setItem("bideshpro_history", JSON.stringify(updated)); } catch (_) {}
      return updated;
    });
  }, []);

  const handleCopy = useCallback(async (text) => {
    if (await copyToClipboard(text)) { setCopied(true); setTimeout(() => setCopied(false), 2500); }
  }, []);

  const filteredCountries = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q));
  }, [debouncedSearch]);


  const buildPrompt = useCallback((country, lvl, bg) => {
    const currentYear = new Date().getFullYear();
    const lvlText = lvl === "all" ? "All Levels (Bachelor, Master's & PhD)" : lvl.charAt(0).toUpperCase() + lvl.slice(1);
    const bgText  = bg  === "all" ? "All Fields (Science, Arts, Commerce)" : bg.charAt(0).toUpperCase() + bg.slice(1);
    
    const gpaInstruction = lvl === "bachelor" 
      ? "ELIGIBILITY FOR BACHELOR: You MUST mention 'HSC / Alim / Equivalent GPA required (out of 5.00)'. Do NOT use the 4.0 scale for Bachelor eligibility."
      : "ELIGIBILITY FOR MASTERS/PHD: You MUST mention 'Bachelor/Master CGPA required (out of 4.00)'.";

    const officialLinksInstruction = country.name.includes("Saudi") 
      ? "OFFICIAL LINK MANDATORY: The official portal for Saudi Arabia is 'https://studyinsaudi.sa/en' or 'https://studyinsaudi.moe.gov.sa'. NEVER link to scholarshipsads.com or other third parties."
      : "OFFICIAL LINK MANDATORY: ONLY provide official government or university domains (.gov, .edu, .uk, etc.). NEVER link to aggregators like scholarshipsads.";

    return `Act as an expert, highly energetic, and meticulous study abroad counselor for Bangladeshi students.

TODAY'S YEAR IS ${currentYear}. USE THE PROVIDED GOOGLE SEARCH CONTEXT TO VERIFY FACTS.

🎯 Target Country: ${country.name}
🎓 Degree Level: ${lvlText}
📚 Field of Study: ${bgText}

🗣️ LANGUAGE: Write the ENTIRE RESPONSE exactly in **${language}**. If Bengali, use flawless and natural Bengali script.

⚠️ STRICT RULES (DO NOT FAIL):
1. **NO LAZY ANSWERS:** Be comprehensive. Describe "Coverage" in detail (e.g., explicitly mention Tuition Fee, Air Tickets, Monthly Stipend amounts, Health Insurance, Accommodation). Do NOT write short phrases like "Tuition fee, subsidy etc."
2. **STRICT FILTERING:** Only provide scholarships that apply to the selected Degree (${lvlText}) and Background (${bgText}).
3. **BANGLADESH QUOTA:** Search the context for exact Bangladesh quota seats for ${currentYear} (e.g., Saudi has EXACTLY 500 seats for Bangladesh). State the factual number.
4. **${gpaInstruction}**
5. **${officialLinksInstruction}**
6. **PART-TIME JOBS:** Explicitly mention if it is legally allowed. If yes, state allowed hours per week and MINIMUM HOURLY WAGE for ${currentYear}.

═══════════════════════════════════
📋 FORMAT (Translate headers to ${language}):
═══════════════════════════════════

## 🎓 Scholarships in ${country.name} (${currentYear})
(List 2-3 specific, highly relevant fully-funded scholarships)

### 🏆 [Official Scholarship Name]
- 💰 **Coverage:** (Detailed breakdown: Tuition, Airfare, Stipend amount, etc.)
- 📅 **Deadline:** (Exact ${currentYear} dates)
- 🗓 **Intake:** (Semester/month)
- ⏳ **Duration:** (Years)
- ✅ **Eligibility:** (${lvl === 'bachelor' ? 'HSC GPA out of 5.00' : 'CGPA out of 4.00'}, IELTS, etc.)
- 🇧🇩 **Bangladesh Quota:** (Exact factual seats available)
- 🔗 **Official Site:** [Official Link](REAL_URL_ONLY)

---

## 💼 Part-Time Jobs & Work Rules (${currentYear})
- **Legal Permission:** (Yes/No, Student Visa rules)
- **Allowed Hours:** (e.g., 20 hours/week)
- **Minimum Wage:** (Exact hourly amount in local currency & ≈ BDT)

## 🏠 Monthly Living Expenses Breakdown
| Category | Cost (Local) | ≈ BDT |
|----------|--------------|-------|
| Accommodation | ... | ... |
| Food | ... | ... |
| Transport | ... | ... |
| Total | ... | ... |

## 🔗 Important Official Links
| Resource | Link (REAL_URL_ONLY) |
|----------|----------------------|
| Embassy/Visa | ... |`;
  }, [language]);

  const fetchScholarship = useCallback(async (country, lvl, bg) => {
    if (isOffline) return setError("You are offline. Please check your internet connection.");
    setLoading(true); setError(null); setResultText(null); setCopied(false); setView(VIEWS.RESULT);
    setIsSlowLoading(false);

    const cacheKey = `C_${country.name}_L_${lvl}_B_${bg}_${language}_V2`;
    const cached = CacheService.get(cacheKey);
    if (cached) { setResultText(cached); setLoading(false); return; }

    const slowTimer = setTimeout(() => setIsSlowLoading(true), 12000);
    const currentYear = new Date().getFullYear();

    const realSearchQuery = `Latest fully funded official scholarships in ${country.name} for Bangladeshi students ${currentYear} deadlines quota, ${country.name} student visa part time job allowed hours minimum wage ${currentYear} official website`;

    try {
      const text = await ApiService.fetch("https://studyabroadportal.onrender.com/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: buildPrompt(country, lvl, bg), locationData: userInfo, searchQuery: realSearchQuery }),
      });
      CacheService.set(cacheKey, text);
      setResultText(text);
    } catch (err) {
      setError(err.message.includes("not found") ? "⚠️ Backend API error. Try again." : err.message);
    } finally { 
      clearTimeout(slowTimer);
      setLoading(false); setIsSlowLoading(false);
    }
  }, [userInfo, isOffline, language, buildPrompt]);

  const handleGlobalAsk = useCallback(async (qOverride) => {
    const q = typeof qOverride === "string" ? qOverride : globalQ;
    if (!q.trim() || isOffline) return;

    setLoading(true); setGlobalResult(null); setView(VIEWS.SEARCH); setCopied(false);
    setIsSlowLoading(false);

    const cacheKey = `Global_${q.trim()}_${language}_V2`;
    const cached = CacheService.get(cacheKey);
    if (cached) { setGlobalResult(cached); setLoading(false); saveHistory(q); return; }
    
    const prompt = `Act as an expert study abroad counselor. User Question: "${q}"
RULES:
- Write entirely in ${language}.
- Be highly energetic and detailed. No lazy answers.
- Today is ${new Date().getFullYear()}. Use search context for factual, updated data.
- ONLY provide REAL, official working URLs (.gov, .edu, etc). NEVER link to fake/aggregator sites.
- Format with bold text, bullet points, and clear headers.`;

    const realSearchQuery = `${q} ${new Date().getFullYear()} study abroad official updates facts`;
    const slowTimer = setTimeout(() => setIsSlowLoading(true), 12000);

    try {
      const text = await ApiService.fetch("https://studyabroadportal.onrender.com/api/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, locationData: userInfo, searchQuery: realSearchQuery }),
      });
      CacheService.set(cacheKey, text);
      setGlobalResult(text);
      saveHistory(q);
    } catch (err) { setGlobalResult("❌ Error: " + err.message); } 
    finally { clearTimeout(slowTimer); setLoading(false); setIsSlowLoading(false); }
  }, [globalQ, userInfo, isOffline, language, saveHistory]);

  return (
    <div className={`min-h-screen font-sans selection:bg-[#4a9eff] selection:text-white pb-20 transition-colors duration-300 ${isDark ? "bg-[#03050a] text-[#dde6f0]" : "theme-light"}`}>
      {!isDark && <style>{LIGHT_MODE_CSS}</style>}
      
      {isOffline && <div className="bg-red-600 text-white text-center py-2 text-sm font-bold tracking-wide">⚡ You are offline — cache only</div>}

      <header className="sticky top-0 z-50 bg-[#070b12]/95 backdrop-blur-md border-b border-[#141f2e]">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 cursor-pointer group" onClick={() => { setView(VIEWS.COUNTRIES); setSelectedCountry(null); }}>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#4a9eff] to-[#2563eb] text-white flex items-center justify-center text-xl shadow-lg group-hover:scale-105 transition-transform">🎓</div>
            <div className="flex flex-col">
              <h1 className="text-xl font-bold leading-tight font-serif text-white theme-text-heading">Bidesh<span className="text-[#4a9eff]">Pro</span></h1>
              <p className="text-[10px] text-[#7a94ad] theme-text-muted font-bold uppercase mt-0.5 flex items-center">
                <span className="bg-[#141f2e] text-[#4a9eff] px-1.5 py-0.5 rounded text-[8px] mr-1.5 border border-[#1e3045]">BETA</span>
                by <a href="https://www.linkedin.com/in/RahatAhmedX" target="_blank" rel="noopener noreferrer" className="text-[#4a9eff] hover:underline ml-1" onClick={e=>e.stopPropagation()}>Rahat</a>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => setIsDark(!isDark)} className="w-9 h-9 flex items-center justify-center rounded-xl text-lg bg-[#141f2e] hover:bg-[#1e3045] text-[#8faabb] hover:text-white transition-all">
              {isDark ? "☀️" : "🌙"}
            </button>
            <div className="flex bg-[#141f2e] rounded-xl p-1 border border-[#1e3045]">
              {["Bengali", "English"].map((lang) => (
                <button key={lang} onClick={() => setLanguage(lang)} className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${language === lang ? "bg-[#4a9eff] text-white shadow-md" : "text-[#7a94ad] hover:text-white"}`}>
                  {lang === "English" ? "EN" : "বাং"}
                </button>
              ))}
            </div>
            <button onClick={() => setView(VIEWS.SEARCH)} className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${view === VIEWS.SEARCH ? "bg-[#4a9eff] text-white" : "text-[#7a94ad] hover:text-white bg-[#141f2e] hover:bg-[#1e3045]"}`}>
              🔍 Ask
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-10">
        {view === VIEWS.COUNTRIES && (
          <div className="animate-in fade-in">
            <h2 className="text-4xl md:text-5xl font-serif font-extrabold text-white theme-text-heading mb-10 leading-tight text-center md:text-left">
              Study Abroad Scholarships<br />
              <span className="text-[#4a9eff]">for Bangladeshi Students</span>
            </h2>

            <div className="bg-[#070b12] border border-[#141f2e] rounded-3xl p-6 md:p-8 mb-12 flex flex-col md:flex-row gap-6 shadow-xl">
              <div className="flex-1">
                <label className="block text-xs font-bold text-[#7a94ad] theme-text-muted uppercase tracking-wider mb-3">Search Country</label>
                <input type="text" placeholder="e.g. Germany, Saudi Arabia..." value={countrySearch} onChange={(e) => setCountrySearch(e.target.value)}
                  className="w-full bg-[#0b1119] border-2 border-[#141f2e] focus:border-[#4a9eff] rounded-xl px-5 py-3.5 text-white theme-text-strong outline-none transition-all placeholder-[#3d5269] text-sm" />
              </div>
              <div className="flex flex-col gap-5">
                <div>
                  <label className="block text-xs font-bold text-[#7a94ad] theme-text-muted uppercase tracking-wider mb-3">Degree Level</label>
                  <div className="flex flex-wrap gap-2">
                    {["all","bachelor","masters","phd"].map((l) => (
                      <button key={l} onClick={() => setLevel(l)} className={`px-5 py-2 rounded-xl text-xs font-bold capitalize transition-all ${level === l ? "bg-[#4a9eff] text-white" : "bg-[#141f2e] text-[#8faabb] hover:bg-[#1e3045] hover:text-white"}`}>
                        {l === "all" ? "All Levels" : l === "phd" ? "PhD" : l}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#7a94ad] theme-text-muted uppercase tracking-wider mb-3">Background Field</label>
                  <div className="flex flex-wrap gap-2">
                    {["all","science","arts","commerce"].map((bg) => (
                      <button key={bg} onClick={() => setBackground(bg)} className={`px-5 py-2 rounded-xl text-xs font-bold capitalize transition-all ${background === bg ? "bg-[#2ecc8a] text-[#03050a]" : "bg-[#141f2e] text-[#8faabb] hover:bg-[#1e3045] hover:text-white"}`}>
                        {bg === "all" ? "All Fields" : bg}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-5">
              {filteredCountries.map((c) => (
                <div key={c.name} onClick={() => { setSelectedCountry(c); fetchScholarship(c, level, background); }}
                  className="bg-[#0b1119] border border-[#1e3045] hover:border-[#4a9eff] rounded-2xl p-6 cursor-pointer transition-all hover:-translate-y-1.5 shadow-lg group">
                  <div className="text-4xl mb-4 group-hover:scale-110 transition-transform origin-left">{c.flag}</div>
                  <h3 className="font-bold text-white theme-text-strong text-base mb-2">{c.name}</h3>
                  <p className="text-xs text-[#7a94ad] theme-text-muted line-clamp-2 leading-relaxed">{c.hint}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {view === VIEWS.RESULT && (
          <div className="animate-in fade-in max-w-4xl mx-auto">
            <div className="flex items-center gap-3 mb-8 flex-wrap">
              <button onClick={() => setView(VIEWS.COUNTRIES)} className="bg-[#141f2e] hover:bg-[#1e3045] text-white px-5 py-2 rounded-xl text-sm font-bold transition-all">← Back</button>
              {selectedCountry && (
                <div className="flex items-center gap-2 bg-[#141f2e] px-4 py-2 rounded-xl">
                  <span className="text-xl">{selectedCountry.flag}</span>
                  <span className="font-bold text-white text-sm">{selectedCountry.name}</span>
                </div>
              )}
            </div>

            <div ref={resultRef} className="bg-[#070b12] border border-[#1e3045] rounded-3xl p-8 md:p-12 shadow-2xl">
              <div className="flex justify-between items-start gap-5 mb-10 pb-8 border-b border-[#1e3045]">
                <div>
                  <h2 className="text-3xl md:text-4xl font-serif font-bold text-white theme-text-heading mb-3">{selectedCountry?.flag} {selectedCountry?.name}</h2>
                  <div className="flex flex-wrap gap-2 items-center">
                    <span className="bg-[#141f2e] text-[#2ecc8a] px-3 py-1 rounded-lg text-xs font-bold border border-[#1e3045]">✅ {new Date().getFullYear()} Advanced AI Data</span>
                    <span className="text-[#8faabb] text-xs font-medium">Level: {level.toUpperCase()} | Field: {background.toUpperCase()}</span>
                  </div>
                </div>
                {resultText && !loading && (
                  <button onClick={() => handleCopy(resultText)} className="px-5 py-2.5 bg-[#4a9eff] hover:bg-[#3b82f6] text-white rounded-xl text-sm font-bold transition-all shadow-lg flex-shrink-0">
                    {copied ? "✅ Copied" : "📋 Copy"}
                  </button>
                )}
              </div>

              {loading ? (
                <div className="text-center py-16">
                  <div className="text-6xl animate-bounce mb-8">{selectedCountry?.flag}</div>
                  <h3 className="text-[#4a9eff] font-bold text-xl mb-3">Running Advanced Web Search...</h3>
                  <p className="text-[#7a94ad] text-sm mb-10 max-w-md mx-auto leading-relaxed">
                    Analyzing official {new Date().getFullYear()} government portals, scholarship quotas, and verified work rules for {selectedCountry?.name}. This takes a few extra seconds to ensure accuracy.
                  </p>
                  <SkeletonLoader />
                </div>
              ) : error ? (
                <div className="bg-[#1a0f14] border border-[#e05555]/30 rounded-2xl p-8 text-center">
                  <h4 className="font-bold text-[#e05555] text-lg mb-3">⚠️ AI Processing Error</h4>
                  <p className="text-sm text-[#e05555]/80 mb-6">{error}</p>
                  <button onClick={() => fetchScholarship(selectedCountry, level, background)} className="px-6 py-2.5 bg-[#e05555] text-white rounded-xl font-bold">Try Again</button>
                </div>
              ) : resultText ? (
                <MarkdownRenderer text={resultText} />
              ) : null}
            </div>
          </div>
        )}

        {view === VIEWS.SEARCH && (
          <div className="animate-in fade-in max-w-3xl mx-auto">
            <h2 className="text-4xl font-serif font-bold text-white theme-text-heading mb-4">Ask AI Counselor</h2>
            <p className="text-[#7a94ad] theme-text-muted mb-10 text-base">স্কলারশিপ বা পার্ট-টাইম জব সম্পর্কে বিস্তারিত প্রশ্ন করুন। AI Advanced Search করে {new Date().getFullYear()} সালের ভেরিফায়েড উত্তর দেবে।</p>

            <div className="relative mb-10">
              <textarea value={globalQ} onChange={(e) => setGlobalQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleGlobalAsk(); }}}
                placeholder="Ask anything..."
                className="w-full bg-[#070b12] border-2 border-[#1e3045] focus:border-[#4a9eff] rounded-3xl p-6 pr-[130px] text-white theme-text-strong outline-none resize-none min-h-[160px] text-base transition-all shadow-xl" />
              <button onClick={() => handleGlobalAsk()} disabled={loading || !globalQ.trim()}
                className="absolute bottom-5 right-5 bg-[#4a9eff] hover:bg-[#3b82f6] disabled:opacity-50 text-white font-bold px-7 py-3 rounded-2xl transition-all shadow-lg">
                {loading ? "Thinking…" : "Ask AI ✈️"}
              </button>
            </div>

            {loading ? (
              <div className="bg-[#070b12] rounded-3xl p-10 border border-[#1e3045] text-center shadow-2xl">
                <p className="text-[#2ecc8a] text-base mb-6 font-bold animate-pulse">Running Deep Web Analysis. Please wait...</p>
                <SkeletonLoader />
              </div>
            ) : globalResult ? (
              <div className="bg-[#070b12] border border-[#1e3045] rounded-3xl p-8 md:p-10 relative shadow-2xl">
                {!globalResult.startsWith("❌") && <button onClick={() => handleCopy(globalResult)} className="absolute top-6 right-6 px-4 py-2 bg-[#141f2e] hover:bg-[#1e3045] text-white font-bold rounded-xl text-xs transition-colors">{copied ? "✅" : "📋 Copy"}</button>}
                <MarkdownRenderer text={globalResult} />
              </div>
            ) : null}
          </div>
        )}
      </main>
      <footer className="mt-10 py-8 text-center text-xs text-[#7a94ad] theme-text-muted border-t border-[#1e3045]">
         <div className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center px-4 gap-4">
            <p><b>BideshPro</b> © {new Date().getFullYear()} · By <a href="https://www.linkedin.com/in/RahatAhmedX" target="_blank" rel="noopener noreferrer" className="text-[#4a9eff] hover:underline">Rahat Ahmed</a></p>
            <p>⚠️ AI search results may contain inaccuracies. Always verify from official websites.</p>
         </div>
      </footer>
    </div>
  );
}

export default function AppWrapper() { return <ErrorBoundary><MainApp /></ErrorBoundary>; }