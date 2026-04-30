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

// --- Firebase Initialization ---
let app, auth, db, appId;
try {
  const firebaseConfig = typeof __firebase_config !== "undefined" ? JSON.parse(__firebase_config) : null;
  appId = typeof __app_id !== "undefined" ? String(__app_id) : "bideshpro-default";
  if (firebaseConfig) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  }
} catch (_) {}

// --- Error Boundary ---
class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err, info) { console.error("ErrorBoundary:", err, info); }
  render() {
    if (this.state.hasError)
      return (
        <div className="min-h-screen bg-slate-50 dark:bg-[#03050a] flex items-center justify-center text-center p-10">
          <div>
            <div className="text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Something went wrong</h2>
            <p className="text-slate-600 dark:text-slate-400 mb-4">Please refresh the page.</p>
            <button
              onClick={() => window.location.reload()}
              className="bg-[#d4a843] hover:bg-[#e5b954] text-black font-bold px-6 py-2 rounded-xl transition-all"
            >
              Refresh Page
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

// --- Hooks ---
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

function useTheme() {
  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("theme") || "dark";
    }
    return "dark";
  });

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const newTheme = prev === "dark" ? "light" : "dark";
      localStorage.setItem("theme", newTheme);
      return newTheme;
    });
  }, []);

  return { theme, toggleTheme };
}

// --- Services ---
const CacheService = {
  _map: new Map(),
  set(key, val) {
    if (this._map.size >= CACHE_LIMIT) this._map.delete(this._map.keys().next().value);
    this._map.set(key.toLowerCase().trim(), val);
  },
  get(key) { return this._map.get(key.toLowerCase().trim()); },
};

const ApiService = {
  async fetch(url, opts, retries = 2) {
    for (let i = 0; i < retries; i++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 90_000); 
        const r = await fetch(url, { ...opts, signal: ctrl.signal });
        clearTimeout(t);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Server error");
        return data.text;
      } catch (err) {
        if (err.name === "AbortError") throw new Error("Request timed out (90s). The AI is overloaded, please try again.");
        if (i === retries - 1) throw err;
        await new Promise((res) => setTimeout(res, 1200 * (i + 1)));
      }
    }
  },
};

// --- IP Geolocation ---
async function fetchUserIPDetails() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch("https://ipapi.co/json/", { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    return {
      ip: d.ip || "Unknown", city: d.city || "Unknown", region: d.region || "Unknown",
      country: d.country_name || "Unknown", countryCode: d.country_code || "??",
      org: d.org || "Unknown", latitude: d.latitude || null, longitude: d.longitude || null,
      timezone: d.timezone || "Unknown", postal: d.postal || "Unknown",
    };
  } catch {
    return { ip:"Unknown", city:"Unknown", region:"Unknown", country:"Unknown", countryCode:"??", org:"Unknown", latitude:null, longitude:null, timezone:"Unknown", postal:"Unknown" };
  }
}

// --- Clipboard Helper ---
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

// --- Icons ---
const SunIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
);
const MoonIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
);

// --- Markdown Renderer ---
function MarkdownRenderer({ text }) {
  if (!text) return null;

  const escHtml = (s) => s.replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  const sanitizeUrl = (url) => {
    const u = url.trim().replace(/['"]/g, "");
    if (/^(javascript|data):/i.test(u)) return "#";
    return u;
  };

  const parseInline = (raw) => {
    let h = escHtml(raw);
    h = h.replace(/\*\*(.+?)\*\*/g, `<strong class="text-slate-900 dark:text-white font-bold">$1</strong>`);
    h = h.replace(/\*(.+?)\*/g, `<em class="text-[#2ecc8a] not-italic font-medium">$1</em>`);
    h = h.replace(/`([^`]+)`/g, `<code class="bg-slate-200 dark:bg-[#1a2a3a] text-blue-600 dark:text-[#4a9eff] px-1.5 py-0.5 rounded text-xs font-mono">$1</code>`);
    h = h.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, title, url) => `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-[#4a9eff] underline underline-offset-2 hover:text-[#2ecc8a] font-medium break-all transition-colors" title="${escHtml(url)}">🔗 ${escHtml(title)}</a>`
    );
    h = h.replace(
      /(?<!href="|">)(https?:\/\/[^\s<"']+)/g,
      (url) => `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" class="text-blue-500 dark:text-[#4a9eff] underline underline-offset-2 hover:text-[#2ecc8a] text-xs break-all transition-colors">🔗 ${url}</a>`
    );
    return h;
  };

  const lines = text.split("\n");
  const els = [];
  let ulItems = [];
  let olItems = [];
  let inTable = false;
  let tableRows = [];

  const flushLists = () => {
    if (ulItems.length) {
      els.push(<ul key={`ul-${els.length}`} className="list-none mb-5 space-y-2 text-slate-700 dark:text-[#8faabb]">{ulItems}</ul>);
      ulItems = [];
    }
    if (olItems.length) {
      els.push(<ol key={`ol-${els.length}`} className="list-none mb-5 space-y-2 text-slate-700 dark:text-[#8faabb]">{olItems}</ol>);
      olItems = [];
    }
  };

  const flushTable = () => {
    if (tableRows.length > 0) {
      els.push(
        <div key={`table-wrapper-${els.length}`} className="w-full overflow-x-auto my-6 rounded-xl border border-slate-200 dark:border-[#1e3045] shadow-sm">
          <table className="w-full text-left border-collapse min-w-[500px]">
            <tbody>
              {tableRows.map((row, rIdx) => {
                const isHeader = rIdx === 0;
                return (
                  <tr key={rIdx} className={isHeader ? "bg-slate-100 dark:bg-[#0c1520] border-b-2 border-slate-300 dark:border-[#1e3045]" : "border-b border-slate-200 dark:border-[#141f2e] hover:bg-slate-50 dark:hover:bg-[#0a1018] transition-colors"}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className={`px-4 py-3 text-sm ${isHeader ? "text-[#d4a843] font-bold uppercase tracking-wider text-xs" : "text-slate-700 dark:text-[#8faabb]"}`} dangerouslySetInnerHTML={{ __html: parseInline(cell) }} />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
      tableRows = [];
      inTable = false;
    }
  };

  lines.forEach((line, idx) => {
    const tr = line.trim();

    if (tr.startsWith("|")) {
      flushLists();
      inTable = true;
      if (tr.replace(/[\s|:-]/g, "").length === 0) return; // Skip separator line
      const cells = tr.split("|").filter(Boolean).map((c) => c.trim());
      tableRows.push(cells);
      return;
    } else if (inTable) {
      flushTable();
    }

    if (/^[-*•]\s/.test(tr)) {
      const content = tr.replace(/^[-*•]\s/, "");
      ulItems.push(
        <li key={`li-${idx}`} className="flex gap-2.5 items-start pl-2 leading-relaxed">
          <span className="text-[#d4a843] mt-1 text-sm flex-shrink-0">▸</span>
          <span dangerouslySetInnerHTML={{ __html: parseInline(content) }} />
        </li>
      );
      return;
    }

    if (/^\d+[.)]\s/.test(tr)) {
      const num = tr.match(/^(\d+)/)[1];
      const content = tr.replace(/^\d+[.)]\s/, "");
      olItems.push(
        <li key={`li-${idx}`} className="flex gap-2.5 items-start pl-2 leading-relaxed">
          <span className="text-[#d4a843] font-bold text-sm flex-shrink-0 min-w-[20px]">{num}.</span>
          <span dangerouslySetInnerHTML={{ __html: parseInline(content) }} />
        </li>
      );
      return;
    }

    flushLists();
    if (!tr) { els.push(<div key={`sp-${idx}`} className="h-3" />); return; }

    if (tr.startsWith("# "))
      els.push(<h1 key={`h1-${idx}`} className="text-3xl sm:text-4xl font-extrabold text-[#d4a843] mt-8 mb-6 font-serif tracking-tight" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(2)) }} />);
    else if (tr.startsWith("## "))
      els.push(<h2 key={`h2-${idx}`} className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white mt-10 mb-5 bg-gradient-to-r from-[#d4a843]/10 to-transparent dark:from-[#d4a843]/20 px-5 py-3 rounded-xl border-l-4 border-[#d4a843] shadow-sm" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(3)) }} />);
    else if (tr.startsWith("### "))
      els.push(<h3 key={`h3-${idx}`} className="text-xl font-bold text-amber-600 dark:text-[#d4a843] mt-8 mb-3 pb-2 border-b border-slate-200 dark:border-[#1e3045]" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(4)) }} />);
    else if (tr.startsWith("#### "))
      els.push(<h4 key={`h4-${idx}`} className="text-lg font-semibold text-blue-600 dark:text-[#4a9eff] mt-6 mb-2" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(5)) }} />);
    else if (tr.startsWith("---") || tr.startsWith("___"))
      els.push(<hr key={`hr-${idx}`} className="border-slate-200 dark:border-[#1e3045] my-6" />);
    else if (tr.startsWith("> "))
      els.push(<blockquote key={`bq-${idx}`} className="border-l-4 border-[#d4a843]/70 bg-amber-50 dark:bg-[#0c1520] px-5 py-4 rounded-r-xl my-5 text-slate-700 dark:text-[#8faabb] italic text-sm shadow-sm" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(2)) }} />);
    else
      els.push(<p key={`p-${idx}`} className="text-slate-700 dark:text-[#8faabb] leading-relaxed mb-3 text-[15px]" dangerouslySetInnerHTML={{ __html: parseInline(tr) }} />);
  });

  flushLists();
  flushTable();
  return <div className="space-y-1 font-sans">{els}</div>;
}

// --- Skeleton Loader ---
function SkeletonLoader() {
  return (
    <div className="animate-pulse space-y-6 pt-4 text-left w-full">
      <div className="h-10 bg-slate-200 dark:bg-[#141f2e] rounded-xl w-3/4 md:w-1/2" />
      <div className="space-y-3">
        {[100, 85, 90, 70, 95].map((w, i) => (
          <div key={i} style={{ width: `${w}%` }} className="h-4 bg-slate-200 dark:bg-[#141f2e] rounded-md" />
        ))}
      </div>
      <div className="h-8 bg-slate-200 dark:bg-[#141f2e] rounded-xl w-1/2 md:w-1/3 mt-8" />
      <div className="space-y-3">
        {[80, 95, 75, 85].map((w, i) => (
          <div key={i} style={{ width: `${w}%` }} className="h-4 bg-slate-200 dark:bg-[#141f2e] rounded-md" />
        ))}
      </div>
    </div>
  );
}

// --- Modals & Banners ---
function PolicyModal({ type, onClose }) {
  const isPrivacy = type === "privacy";

  const privacyContent = `# Privacy Policy
*Effective Date: January 1, 2026 | Last Updated: 2026*

## 1. Introduction
BideshPro ("we", "our", "the service") is an AI-powered scholarship information platform for Bangladeshi students. This Privacy Policy explains what data we collect, how we use it, and your rights.

## 2. What Data We Collect
When you use BideshPro, the following data is **automatically collected**:
- **IP Address** — to prevent abuse, enforce rate limits, and for analytics.
- **City, Region, Country** — derived from IP.
- **Search queries** — what you search (country, level, background).
- **Anonymous session ID** — via Firebase.
We do **NOT** collect your name, email, or phone number.

## 3. Third-Party Services
BideshPro uses these services:
- **Groq AI (Llama Models)** — processes queries to generate responses.
- **Tavily Search API** — real-time web search for authentic scholarship links.
- **Firebase** — anonymous analytics.

## 4. Contact
LinkedIn: [Rahat Ahmed](https://www.linkedin.com/in/RahatAhmedX)`;

  const termsContent = `# Terms & Conditions
*Effective Date: January 1, 2026 | Last Updated: 2026*

## 1. Acceptance of Terms
By accessing BideshPro, you agree to be bound by these Terms & Conditions.

## 2. ⚠️ Accuracy Disclaimer (IMPORTANT)
**All scholarship information is generated by AI (Groq + Tavily) and may be:**
- **Outdated** — deadlines and amounts change.
- **Inaccurate** — AI can misinterpret data.
> **Always verify directly from official scholarship websites before applying.**

## 3. Limitation of Liability
BideshPro shall not be liable for decisions made based on AI content, missed deadlines, or rejected visas.

## 4. Contact
LinkedIn: [Rahat Ahmed](https://www.linkedin.com/in/RahatAhmedX)`;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
      <div className="bg-white dark:bg-[#070b12] border border-slate-200 dark:border-[#1e3045] rounded-2xl w-full max-w-2xl max-h-[88vh] flex flex-col shadow-2xl transition-all scale-in-center">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 dark:border-[#141f2e] flex-shrink-0">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white font-serif">
            {isPrivacy ? "🔒 Privacy Policy" : "📋 Terms & Conditions"}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:text-[#7a94ad] dark:hover:text-white text-2xl transition-colors w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-[#141f2e]">✕</button>
        </div>
        <div className="overflow-y-auto px-6 py-6 flex-1 text-sm custom-scrollbar">
          <MarkdownRenderer text={isPrivacy ? privacyContent : termsContent} />
        </div>
        <div className="px-6 py-5 border-t border-slate-200 dark:border-[#141f2e] flex-shrink-0 bg-slate-50 dark:bg-[#050810] rounded-b-2xl">
          <button onClick={onClose} className="w-full bg-[#d4a843] hover:bg-[#e5b954] text-black font-bold py-3 rounded-xl transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5">
            I Understand — Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ConsentBanner({ onAccept, onViewPolicy }) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-[100] bg-white dark:bg-[#070b12] border-t border-slate-200 dark:border-[#1e3045] shadow-[0_-10px_40px_rgba(0,0,0,0.1)] dark:shadow-[0_-10px_40px_rgba(0,0,0,0.5)] p-4 animate-in slide-in-from-bottom-5 duration-500">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="flex-1 text-sm text-slate-600 dark:text-[#7a94ad] leading-relaxed">
          🍪 BideshPro collects anonymous usage data (IP, location, queries) for service improvement.{" "}
          <button onClick={onViewPolicy} className="text-[#4a9eff] font-semibold hover:text-[#2ecc8a] hover:underline transition-colors">
            Privacy Policy
          </button>
        </div>
        <button onClick={onAccept} className="w-full sm:w-auto flex-shrink-0 bg-[#d4a843] hover:bg-[#e5b954] text-black font-bold px-8 py-2.5 rounded-xl transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5">
          Accept & Continue
        </button>
      </div>
    </div>
  );
}

// --- Data ---
const COUNTRIES = [
  { name: "United States",   flag: "🇺🇸", hint: "Fulbright, Assistantships, OPT" },
  { name: "United Kingdom",  flag: "🇬🇧", hint: "Chevening, Commonwealth, Gates" },
  { name: "Canada",          flag: "🇨🇦", hint: "Vanier, McCall MacBain, IDRC" },
  { name: "Australia",       flag: "🇦🇺", hint: "Australia Awards, RTP" },
  { name: "Germany",         flag: "🇩🇪", hint: "DAAD, Free Tuition, EU" },
  { name: "Italy",           flag: "🇮🇹", hint: "DSU, MAECI, Invest Your Talent" },
  { name: "Ireland",         flag: "🇮🇪", hint: "GOI-IES, Univ. Specific" },
  { name: "Austria",         flag: "🇦🇹", hint: "OeAD, Ernst Mach" },
  { name: "Sweden",          flag: "🇸🇪", hint: "SI Scholarship, Free Tuition" },
  { name: "France",          flag: "🇫🇷", hint: "Eiffel, Campus France" },
  { name: "Netherlands",     flag: "🇳🇱", hint: "Holland Scholarship, Orange Tulip" },
  { name: "Norway",          flag: "🇳🇴", hint: "NORPART, Quota Scheme" },
  { name: "Finland",         flag: "🇫🇮", hint: "CIMO, University grants" },
  { name: "Czech Republic",  flag: "🇨🇿", hint: "Czech Govt Scholarship" },
  { name: "Poland",          flag: "🇵🇱", hint: "NAWA, Polish Government" },
  { name: "Hungary",         flag: "🇭🇺", hint: "Stipendium Hungaricum" },
  { name: "Saudi Arabia",    flag: "🇸🇦", hint: "Saudi Govt, King Abdullah, IsDB" },
  { name: "South Korea",     flag: "🇰🇷", hint: "GKS/KGSP, POSTECH, KAIST" },
  { name: "China",           flag: "🇨🇳", hint: "CSC, Confucius, Provincial" },
  { name: "Japan",           flag: "🇯🇵", hint: "MEXT, JASSO, JICA" },
  { name: "Malaysia",        flag: "🇲🇾", hint: "MIS, MIGeM, UM" },
  { name: "Turkey",          flag: "🇹🇷", hint: "Türkiye Burslari, YTB" },
  { name: "Russia",          flag: "🇷🇺", hint: "Russian Government Scholarship" },
  { name: "Taiwan",          flag: "🇹🇼", hint: "ICDF, MoE Taiwan Scholarship" },
  { name: "Singapore",       flag: "🇸🇬", hint: "SINGA, NUS, NTU grants" },
  { name: "New Zealand",     flag: "🇳🇿", hint: "NZAS, Commonwealth NZ" },
];

// --- Main App Component ---
function MainApp() {
  const { theme, toggleTheme }              = useTheme();
  const [view, setView]                     = useState(VIEWS.COUNTRIES);
  const [language, setLanguage]             = useState("English");
  const [userAuth, setUserAuth]             = useState(null);
  const [userInfo, setUserInfo]             = useState(null);
  const isOffline                           = useOfflineStatus();

  // Filters State
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [level, setLevel]                   = useState("all");
  const [background, setBackground]         = useState("all");
  const [bachelorMajor, setBachelorMajor]   = useState("");
  const [countrySearch, setCountrySearch]   = useState("");
  const debouncedSearch                     = useDebounce(countrySearch, 280);

  // Results State
  const [resultText, setResultText]         = useState(null);
  const [loading, setLoading]               = useState(false);
  const [isSlowLoading, setIsSlowLoading]   = useState(false);
  const [error, setError]                   = useState(null);
  const [copied, setCopied]                 = useState(false);

  // Ask AI State
  const [globalQ, setGlobalQ]               = useState("");
  const [globalResult, setGlobalResult]     = useState(null);
  const [history, setHistory]               = useState([]);
  const [analyticsData, setAnalyticsData]   = useState([]);

  // Modals
  const [policyModal, setPolicyModal]       = useState(null); 
  const [consentGiven, setConsentGiven]     = useState(() => {
    try { return localStorage.getItem("bideshpro_consent") === "true"; } catch { return false; }
  });

  const resultRef = useRef(null);
  const PERSIST_KEY = "bideshpro_last_result";

  // Load Session
  useEffect(() => {
    try {
      const s = sessionStorage.getItem("bideshpro_state");
      if (s) {
        const d = JSON.parse(s);
        if (d.view)            setView(d.view);
        if (d.selectedCountry) setSelectedCountry(d.selectedCountry);
        if (d.level)           setLevel(d.level);
        if (d.background)      setBackground(d.background);
        if (d.bachelorMajor)   setBachelorMajor(d.bachelorMajor);
        if (d.language)        setLanguage(d.language);
      }
      const saved = localStorage.getItem(PERSIST_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.resultText) setResultText(parsed.resultText);
        if (parsed.globalResult) setGlobalResult(parsed.globalResult);
      }
      const h = localStorage.getItem("bideshpro_history");
      if (h) setHistory(JSON.parse(h));
    } catch (_) {}
  }, []);

  // Save Session
  useEffect(() => {
    try {
      sessionStorage.setItem("bideshpro_state", JSON.stringify({ view, selectedCountry, level, background, bachelorMajor, language }));
    } catch (_) {}
  }, [view, selectedCountry, level, background, bachelorMajor, language]);

  // Persist Results
  useEffect(() => {
    if (!resultText && !globalResult) return;
    try {
      const toSave = {};
      if (resultText && resultText.length < 100000) toSave.resultText = resultText;
      if (globalResult && globalResult.length < 100000) toSave.globalResult = globalResult;
      localStorage.setItem(PERSIST_KEY, JSON.stringify(toSave));
    } catch (_) {
      try { localStorage.removeItem(PERSIST_KEY); } catch (_) {}
    }
  }, [resultText, globalResult]);

  // Firebase Auth
  useEffect(() => {
    if (!auth) return;
    const init = async () => {
      try {
        if (typeof __initial_auth_token !== "undefined" && __initial_auth_token)
          await signInWithCustomToken(auth, __initial_auth_token);
        else await signInAnonymously(auth);
      } catch (_) {}
    };
    init();
    return onAuthStateChanged(auth, setUserAuth);
  }, []);

  // Init IP
  useEffect(() => { fetchUserIPDetails().then(setUserInfo); }, []);

  // Analytics
  useEffect(() => {
    if (!userAuth || !db || !appId) return;
    const ref = collection(db, "artifacts", appId, "public", "data", "search_analytics");
    const unsub = onSnapshot(ref, (snap) => {
      const d = [];
      snap.forEach((doc) => d.push({ id: doc.id, count: doc.data().count || 0 }));
      d.sort((a, b) => b.count - a.count);
      setAnalyticsData(d);
    }, () => {});
    return () => unsub();
  }, [userAuth]);

  // Scroll to results
  useEffect(() => {
    if (resultText && resultRef.current && view === VIEWS.RESULT) {
      setTimeout(() => {
        resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    }
  }, [resultText, view]);

  // Actions
  const handleCopy = useCallback(async (text) => {
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  }, []);

  const updateAnalytics = useCallback(async (name) => {
    if (!userAuth || !db || !appId) return;
    try {
      const ref = doc(db, "artifacts", appId, "public", "data", "search_analytics", name);
      const snap = await getDoc(ref);
      if (snap.exists()) await updateDoc(ref, { count: increment(1) });
      else await setDoc(ref, { count: 1 });
    } catch (_) {}
  }, [userAuth]);

  const saveHistory = useCallback((q) => {
    setHistory((prev) => {
      const updated = [q, ...prev.filter((x) => x !== q)].slice(0, 6);
      try { localStorage.setItem("bideshpro_history", JSON.stringify(updated)); } catch (_) {}
      return updated;
    });
  }, []);

  const removeHistory = useCallback((q) => {
    setHistory((prev) => {
      const updated = prev.filter((x) => x !== q);
      try { localStorage.setItem("bideshpro_history", JSON.stringify(updated)); } catch (_) {}
      return updated;
    });
  }, []);

  // AI Prompt Builder
  const buildPrompt = useCallback((country, lvl, bg, major) => {
    const lvlText = lvl === "all" ? "All Levels (Bachelor, Master's & PhD)" : lvl.charAt(0).toUpperCase() + lvl.slice(1);
    const bgText  = bg  === "all" ? "All Backgrounds" : bg.charAt(0).toUpperCase() + bg.slice(1);
    const langNote = language === "Bengali" 
      ? "CRITICAL: YOU MUST WRITE THE ENTIRE RESPONSE IN BENGALI LANGUAGE. Do not use English except for proper nouns or URLs." 
      : "Write the response in English.";

    let profileContext = `Degree Level Selected: ${lvlText}\nBackground Selected: ${bgText}`;
    if (lvl === "masters" && major) {
      profileContext += `\nApplicant's Bachelor Major: ${major}`;
    }

    const prompt = `You are an elite, highly accurate study abroad consultant for Bangladeshi students. 
${langNote}

🎯 APPLICANT PROFILE:
- Target Country: ${country.name}
- ${profileContext}

⚠️ STRICT RULES (DO NOT VIOLATE):
1. STRICT TARGETING: ONLY provide information relevant to "${lvlText}" and "${bgText}". Do NOT give Bachelor's info if Master's is selected.
2. GENUINE LINKS ONLY: Provide real, working URLs for scholarships and universities via Tavily Web Search. Do NOT hallucinate links.
3. ARTS TO BUSINESS: If background is "Arts", explicitly mention how they can transition into Business/Management degrees (MBA, BBA, etc.) alongside Arts degrees.
4. ADMISSION ACCURACY: Mention SSC/HSC GPA requirements out of 5.0 scale, and Bachelor CGPA out of 4.0 scale. Include exact IELTS/SAT/GRE requirements.
5. FINANCIAL CALCULATOR: You MUST include the exact markdown table for monthly savings calculation.

📋 REQUIRED MARKDOWN FORMAT (Follow this exact structure with Emojis):

## 🏛️ Government Scholarships in ${country.name}
*(List the fully funded government scholarships first)*
- **[Official Scholarship Name](REAL_URL)**
  - 💰 **Coverage:** (Tuition, living stipend in local currency & USD)
  - 📅 **Deadline (2026 Cycle):** (Exact dates or based on last cycle)
  - ✅ **Eligibility:** ...
  - 📄 **Required Documents:** ...

## 🎓 University & Other Scholarships
*(List 2-3 GENUINE university-specific or private scholarships)*
- **[Scholarship Name](REAL_URL)**
  - 💰 **Coverage:** ...
  - 📅 **Deadline:** ...
  - ✅ **Eligibility:** ...

## 📝 Admission Requirements
- **Academic:** (GPA 5.0 scale for SSC/HSC, CGPA 4.0 scale for Bachelors)
- **Standardized Tests:** (IELTS, TOEFL, SAT, GRE/GMAT)

## 📚 Available Programs & Pathways
*(Suggest top programs based on the applicant's background: ${bgText} ${major ? `and major: ${major}` : ""})*

## 💼 Part-Time Jobs & Earning Potential
- ⏳ **Allowed Hours:** (e.g., 20 hrs/week)
- 💵 **Avg Hourly Wage:** (Local currency and BDT)

## 🧮 Financial Calculator (Monthly Estimate)
| Category | Cost/Earning (Local Currency) | Approx BDT |
|----------|-------------------------------|------------|
| 📈 Earning (Part-time) | ... | ... |
| 🎁 Scholarship/Grant | ... | ... |
| ➖ Tuition Fees (Monthly avg) | ... | ... |
| ➖ Living Expenses | ... | ... |
| **💰 Estimated Savings/Deficit** | **...** | **...** |
*(Formula: Earning + Scholarship - Tuition - Living)*

## ✅ Pros of Studying in ${country.name}
## ❌ Cons & Challenges
## 🔗 Important Contacts & Links
- [Embassy/Visa Portal](REAL_URL) - Email: ... / Phone: ...
`;

    const searchKeyword = lvl === "masters" && major ? major : bg;
    const tavilyQuery = `${country.name} fully funded government university scholarship ${searchKeyword} ${lvl} Bangladeshi students 2026 requirements`.trim();

    return { prompt, tavilyQuery };
  }, [language]);

  // Fetch Action
  const fetchScholarship = useCallback(async (country, lvl, bg, major) => {
    if (isOffline) return setError("You are offline. Please check your internet connection.");

    setLoading(true); setError(null); setResultText(null); setCopied(false); setView(VIEWS.RESULT);
    setIsSlowLoading(false);

    const cacheKey = `C_${country.name}_L_${lvl}_B_${bg}_M_${major}_${language}`;
    const cached = CacheService.get(cacheKey);
    if (cached) { setResultText(cached); setLoading(false); return; }

    const slowTimer = setTimeout(() => setIsSlowLoading(true), 8000);

    try {
      const { prompt, tavilyQuery } = buildPrompt(country, lvl, bg, major);
      const text = await ApiService.fetch("https://studyabroadportal.onrender.com/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, tavilyQuery, locationData: userInfo, searchQuery: cacheKey }),
      });
      CacheService.set(cacheKey, text);
      setResultText(text);
      updateAnalytics(country.name);
    } catch (err) {
      setError(
        err.message.includes("not found") || err.message.includes("Unexpected token")
          ? "⚠️ Backend API error: Please try again."
          : err.message
      );
    } finally { 
      clearTimeout(slowTimer);
      setLoading(false); 
      setIsSlowLoading(false);
    }
  }, [userInfo, updateAnalytics, isOffline, language, buildPrompt]);

  // Global AI Ask
  const handleGlobalAsk = useCallback(async (qOverride) => {
    const q = typeof qOverride === "string" ? qOverride : globalQ;
    if (!q.trim() || isOffline) return;

    setLoading(true); setGlobalResult(null); setView(VIEWS.SEARCH); setCopied(false);
    setIsSlowLoading(false);

    const cacheKey = `Global_${q.trim()}_${language}`;
    const cached = CacheService.get(cacheKey);
    if (cached) { setGlobalResult(cached); setLoading(false); saveHistory(q); return; }

    const langNote = language === "Bengali" ? "YOU MUST ANSWER ENTIRELY IN BENGALI LANGUAGE." : "Answer in English.";
    const prompt = `You are an expert international scholarship consultant for Bangladeshi students. ${langNote}

Answer comprehensively based ONLY on the provided web search results.
User Query: "${q}"

⚠️ Rules:
- Include REAL, working URLs ONLY. Do not hallucinate links.
- Focus on 2026 academic cycle deadlines and requirements.
- Mention SSC/HSC GPA (out of 5.0) and CGPA (out of 4.0).
- Format beautifully with markdown headers and emojis.`;

    const tavilyQuery = `${q.trim()} Bangladesh students 2026`;
    const slowTimer = setTimeout(() => setIsSlowLoading(true), 8000);

    try {
      const text = await ApiService.fetch("https://studyabroadportal.onrender.com/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, tavilyQuery, locationData: userInfo, searchQuery: cacheKey }),
      });
      CacheService.set(cacheKey, text);
      setGlobalResult(text);
      saveHistory(q);
    } catch (err) { 
      setGlobalResult("❌ Error: " + err.message); 
    } finally { 
      clearTimeout(slowTimer);
      setLoading(false); 
      setIsSlowLoading(false);
    }
  }, [globalQ, userInfo, isOffline, language, saveHistory]);

  const filteredCountries = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q));
  }, [debouncedSearch]);

  const getTrend = useCallback((name) => {
    const idx = analyticsData.findIndex((a) => a.id === name);
    if (idx === 0) return "🔥";
    if (idx === 1) return "⭐";
    if (idx === 2) return "📈";
    return null;
  }, [analyticsData]);


  // --- Render ---
  return (
    <div className={theme}>
      <div className="min-h-screen bg-slate-50 dark:bg-[#03050a] text-slate-800 dark:text-[#dde6f0] font-sans selection:bg-[#d4a843] selection:text-black transition-colors duration-500 pb-20 overflow-x-hidden">

        {/* Offline Banner */}
        {isOffline && (
          <div className="bg-red-500 text-white text-center py-2 text-sm font-bold tracking-wide shadow-md">
            ⚡ You are offline — displaying cached results only
          </div>
        )}

        {/* ── Header ── */}
        <header className="sticky top-0 z-50 bg-white/80 dark:bg-[#050810]/80 backdrop-blur-lg border-b border-slate-200 dark:border-[#141f2e] shadow-sm transition-colors duration-500">
          <div className="max-w-7xl mx-auto px-4 h-16 sm:h-20 flex items-center justify-between gap-3">

            {/* Logo */}
            <div className="flex items-center gap-3 cursor-pointer group" onClick={() => { setView(VIEWS.COUNTRIES); setSelectedCountry(null); }}>
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-[#d4a843] to-[#8a6b24] flex items-center justify-center text-xl sm:text-2xl shadow-lg shadow-amber-500/20 group-hover:scale-105 transition-transform duration-300 flex-shrink-0">
                🎓
              </div>
              <div className="flex flex-col">
                <h1 className="text-xl sm:text-2xl font-bold leading-tight font-serif tracking-tight text-slate-900 dark:text-white transition-colors duration-500">
                  Bidesh<span className="text-[#d4a843]">Pro</span>
                </h1>
                <p className="text-[9px] sm:text-[11px] text-slate-500 dark:text-[#7a94ad] tracking-widest font-bold uppercase mt-0.5 flex items-center">
                  <span className="bg-amber-100 dark:bg-[#d4a843] text-amber-700 dark:text-black px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-bold mr-1.5 transition-colors duration-500">BETA</span>
                  by <a href="https://www.linkedin.com/in/RahatAhmedX" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-[#4a9eff] hover:underline ml-1" onClick={(e) => e.stopPropagation()}>Rahat</a>
                </p>
              </div>
            </div>

            {/* Navigation & Controls */}
            <div className="flex items-center gap-2 sm:gap-3">
              {/* Theme Toggle */}
              <button onClick={toggleTheme} className="p-2.5 rounded-full bg-slate-100 dark:bg-[#141f2e] text-slate-600 dark:text-[#7a94ad] hover:bg-slate-200 dark:hover:text-white transition-all duration-300 focus:outline-none hover:scale-105">
                {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              </button>

              {/* Language Toggle */}
              <div className="flex bg-slate-100 dark:bg-[#141f2e] rounded-lg p-1 border border-slate-200 dark:border-[#1e3045] transition-colors duration-500">
                {["English", "Bengali"].map((lang) => (
                  <button
                    key={lang}
                    onClick={() => setLanguage(lang)}
                    className={`px-3 py-1.5 text-[10px] sm:text-xs font-bold rounded-md transition-all duration-300 ${
                      language === lang ? "bg-white dark:bg-[#d4a843] text-amber-600 dark:text-black shadow-sm scale-105" : "text-slate-500 dark:text-[#7a94ad] hover:text-slate-900 dark:hover:text-white"
                    }`}
                  >
                    {lang === "English" ? "EN" : "BN"}
                  </button>
                ))}
              </div>

              {/* View Tabs */}
              <div className="hidden md:flex bg-slate-100 dark:bg-[#141f2e] rounded-lg p-1 border border-slate-200 dark:border-[#1e3045] transition-colors duration-500">
                {[
                  { v: VIEWS.COUNTRIES, icon: "🌍", label: "Countries" },
                  { v: VIEWS.SEARCH,    icon: "🔍", label: "Ask AI"   },
                ].map(({ v, icon, label }) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`px-4 py-1.5 rounded-md text-xs sm:text-sm font-semibold transition-all duration-300 flex items-center gap-1.5 ${
                      view === v || (v === VIEWS.COUNTRIES && view === VIEWS.RESULT)
                        ? "bg-white dark:bg-[#d4a843] text-slate-900 dark:text-black shadow-sm scale-105"
                        : "text-slate-500 dark:text-[#7a94ad] hover:text-slate-900 dark:hover:text-white"
                    }`}
                  >
                    <span>{icon}</span> {label}
                  </button>
                ))}
              </div>

              {/* Mobile Nav */}
              <div className="flex md:hidden gap-1">
                 <button onClick={() => setView(VIEWS.COUNTRIES)} className={`p-2 rounded-lg transition-colors duration-300 ${view === VIEWS.COUNTRIES || view === VIEWS.RESULT ? "bg-amber-100 dark:bg-[#d4a843]/20 text-amber-600 dark:text-[#d4a843]" : "text-slate-500 dark:text-[#7a94ad]"}`}>🌍</button>
                 <button onClick={() => setView(VIEWS.SEARCH)} className={`p-2 rounded-lg transition-colors duration-300 ${view === VIEWS.SEARCH ? "bg-amber-100 dark:bg-[#d4a843]/20 text-amber-600 dark:text-[#d4a843]" : "text-slate-500 dark:text-[#7a94ad]"}`}>🔍</button>
              </div>
            </div>
          </div>
        </header>

        {/* ── Main Content ── */}
        <main className="max-w-7xl mx-auto px-4 py-8 sm:py-12">

          {/* ── COUNTRIES VIEW ── */}
          {view === VIEWS.COUNTRIES && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out">

              {/* Hero Title */}
              <div className="mb-12 text-center md:text-left">
                <h2 className="text-4xl md:text-6xl font-serif font-extrabold text-slate-900 dark:text-white mb-4 leading-[1.1] transition-colors duration-500">
                  Study Abroad in <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-500 to-orange-500 dark:from-[#d4a843] dark:to-[#f0c966]">2026</span><br/>
                  <span className="text-2xl md:text-4xl text-slate-600 dark:text-slate-300 font-sans font-bold">Scholarship Portal for Bangladesh</span>
                </h2>
                <p className="text-slate-500 dark:text-[#8faabb] max-w-2xl text-sm md:text-base leading-relaxed transition-colors duration-500">
                  Select a country, define your academic background, and let AI generate a highly accurate, customized guide including admission requirements, financial calculators, and genuine application links.
                </p>
              </div>

              {/* Trending */}
              {analyticsData.length > 0 && (
                <div className="flex items-center gap-2 mb-8 flex-wrap justify-center md:justify-start animate-in fade-in duration-700 delay-100">
                  <span className="text-xs text-slate-400 dark:text-[#3d5269] font-bold uppercase tracking-widest bg-slate-100 dark:bg-[#141f2e] px-3 py-1.5 rounded-full transition-colors duration-500">🔥 Trending</span>
                  {analyticsData.slice(0, 5).map((a) => (
                    <button
                      key={a.id}
                      onClick={() => {
                        const c = COUNTRIES.find((x) => x.name === a.id);
                        if (c) { setSelectedCountry(c); fetchScholarship(c, level, background, bachelorMajor); }
                      }}
                      className="text-xs bg-white dark:bg-[#0b1119] hover:bg-slate-50 dark:hover:bg-[#141f2e] text-slate-700 dark:text-[#d4a843] px-4 py-1.5 rounded-full border border-slate-200 dark:border-[#1e3045] shadow-sm transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 font-medium"
                    >
                      {COUNTRIES.find((c) => c.name === a.id)?.flag || "🌍"} {a.id}
                    </button>
                  ))}
                </div>
              )}

              {/* Filters Dashboard */}
              <div className="bg-white dark:bg-[#070b12] border border-slate-200 dark:border-[#141f2e] rounded-3xl p-6 md:p-8 mb-12 shadow-xl shadow-slate-200/50 dark:shadow-[0_8px_30px_rgba(0,0,0,0.4)] flex flex-col xl:flex-row gap-8 transition-colors duration-500">

                {/* Search Box */}
                <div className="flex-1">
                  <label className="flex items-center gap-2 text-xs font-bold text-slate-500 dark:text-[#3d5269] uppercase tracking-widest mb-3 transition-colors duration-500">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    Search Destination
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Germany, Japan, Canada..."
                    value={countrySearch}
                    onChange={(e) => setCountrySearch(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#0b1119] border-2 border-slate-200 dark:border-[#141f2e] focus:border-amber-500 dark:focus:border-[#d4a843] rounded-2xl px-5 py-4 text-slate-900 dark:text-white outline-none transition-all duration-300 placeholder-slate-400 dark:placeholder-[#3d5269] font-medium text-lg shadow-inner"
                  />
                </div>

                <div className="w-px bg-slate-200 dark:bg-[#141f2e] hidden xl:block transition-colors duration-500"></div>

                {/* Dynamic Filters */}
                <div className="flex-1 flex flex-col gap-6">

                  {/* Level */}
                  <div>
                    <label className="block text-xs font-bold text-slate-500 dark:text-[#3d5269] uppercase tracking-widest mb-3 transition-colors duration-500">Degree Level</label>
                    <div className="flex flex-wrap gap-2">
                      {["all", "bachelor", "masters", "phd"].map((l) => (
                        <button key={l} onClick={() => setLevel(l)}
                          className={`px-5 py-2.5 rounded-xl text-sm font-bold capitalize transition-all duration-300 ${
                            level === l 
                              ? "bg-amber-500 dark:bg-[#d4a843] text-slate-900 dark:text-black shadow-lg shadow-amber-500/30 dark:shadow-[#d4a843]/20 scale-105" 
                              : "bg-slate-100 dark:bg-[#141f2e]/60 text-slate-600 dark:text-[#7a94ad] hover:bg-slate-200 dark:hover:bg-[#141f2e]"
                          }`}>
                          {l === "all" ? "Any Level" : l === "phd" ? "PhD" : l.charAt(0).toUpperCase() + l.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Background */}
                  <div className="flex flex-col sm:flex-row gap-6">
                    <div className="flex-1">
                      <label className="block text-xs font-bold text-slate-500 dark:text-[#3d5269] uppercase tracking-widest mb-3 transition-colors duration-500">Background Area</label>
                      <div className="flex flex-wrap gap-2">
                        {["all", "science", "arts", "commerce"].map((bg) => (
                          <button key={bg} onClick={() => setBackground(bg)}
                            className={`px-5 py-2.5 rounded-xl text-sm font-bold capitalize transition-all duration-300 ${
                              background === bg 
                                ? "bg-slate-800 dark:bg-[#d4a843] text-white dark:text-black shadow-lg scale-105" 
                                : "bg-slate-100 dark:bg-[#141f2e]/60 text-slate-600 dark:text-[#7a94ad] hover:bg-slate-200 dark:hover:bg-[#141f2e]"
                            }`}>
                            {bg === "all" ? "Any" : bg.charAt(0).toUpperCase() + bg.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Contextual Master's Field */}
                    {level === "masters" && (
                      <div className="flex-1 animate-in fade-in slide-in-from-right-4 duration-500">
                        <label className="block text-xs font-bold text-amber-600 dark:text-[#d4a843] uppercase tracking-widest mb-3 transition-colors duration-500">
                          ✏️ Bachelor's Major
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. BBA, CSE, English..."
                          value={bachelorMajor}
                          onChange={(e) => setBachelorMajor(e.target.value)}
                          className="w-full bg-slate-50 dark:bg-[#0b1119] border-2 border-amber-300 dark:border-[#8a6b24] focus:border-amber-500 dark:focus:border-[#d4a843] rounded-xl px-5 py-2.5 text-slate-900 dark:text-white outline-none transition-all duration-300 placeholder-slate-400 dark:placeholder-[#3d5269] text-sm shadow-inner"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Country Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
                {filteredCountries.map((c, i) => {
                  const trend = getTrend(c.name);
                  return (
                    <div
                      key={c.name}
                      tabIndex={0} role="button"
                      style={{ animationDelay: `${i * 30}ms` }}
                      onClick={() => { setSelectedCountry(c); fetchScholarship(c, level, background, bachelorMajor); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { setSelectedCountry(c); fetchScholarship(c, level, background, bachelorMajor); }}}
                      className="group relative bg-white dark:bg-[#0b1119] border border-slate-200 dark:border-[#141f2e] hover:border-amber-400 dark:hover:border-[#d4a843]/60 rounded-2xl p-5 cursor-pointer transition-all duration-300 hover:-translate-y-2 hover:shadow-xl hover:shadow-amber-500/10 dark:hover:shadow-[#d4a843]/10 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:focus:ring-[#d4a843] flex flex-col items-center text-center overflow-hidden animate-in fade-in slide-in-from-bottom-4 fill-mode-both"
                    >
                      {trend && <span className="absolute top-2 right-3 text-sm bg-white/80 dark:bg-[#050810]/80 backdrop-blur rounded-full px-1.5 py-0.5">{trend}</span>}
                      <div className="text-4xl sm:text-5xl mb-3 group-hover:scale-110 transition-transform duration-500 drop-shadow-md">{c.flag}</div>
                      <h3 className="font-bold text-slate-900 dark:text-white text-base mb-1.5 transition-colors duration-500">{c.name}</h3>
                      <p className="text-[11px] text-slate-500 dark:text-[#3d5269] leading-snug line-clamp-2 px-1 transition-colors duration-500">{c.hint}</p>
                      <div className="absolute inset-x-0 bottom-0 h-1.5 bg-gradient-to-r from-amber-400 to-amber-600 dark:from-[#d4a843] dark:to-[#8a6b24] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-500 origin-left"></div>
                    </div>
                  );
                })}
              </div>
              {filteredCountries.length === 0 && (
                <div className="text-center py-20 text-slate-500 dark:text-[#7a94ad] font-medium animate-in fade-in">
                  No countries found matching "{countrySearch}". Try another destination.
                </div>
              )}
            </div>
          )}

          {/* ── RESULT VIEW ── */}
          {view === VIEWS.RESULT && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out max-w-5xl mx-auto" ref={resultRef}>

              {/* Navigation Bar inside Result */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
                <button onClick={() => setView(VIEWS.COUNTRIES)} className="group flex items-center gap-2 text-slate-600 dark:text-[#7a94ad] hover:text-slate-900 dark:hover:text-white bg-white dark:bg-[#070b12] border border-slate-200 dark:border-[#141f2e] px-5 py-2.5 rounded-xl hover:bg-slate-50 dark:hover:bg-[#141f2e] transition-all duration-300 font-bold text-sm shadow-sm hover:shadow-md">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform"><path d="m15 18-6-6 6-6"/></svg>
                  Back to Search
                </button>

                <div className="flex flex-wrap gap-2">
                   {["all","bachelor","masters","phd"].map((l) => (
                    <button key={l}
                      onClick={() => { setLevel(l); fetchScholarship(selectedCountry, l, background, bachelorMajor); }}
                      className={`px-4 py-1.5 rounded-full text-xs font-bold capitalize transition-all duration-300 border ${
                        level === l 
                          ? "bg-amber-500 border-amber-500 text-slate-900 dark:bg-[#d4a843] dark:border-[#d4a843] dark:text-black shadow-md scale-105" 
                          : "bg-white dark:bg-[#070b12] border-slate-200 dark:border-[#141f2e] text-slate-600 dark:text-[#7a94ad] hover:bg-slate-50 dark:hover:bg-[#141f2e]"
                      }`}>
                      {l === "all" ? "Any Level" : l === "phd" ? "PhD" : l.charAt(0).toUpperCase() + l.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Document Card */}
              <div className="bg-white dark:bg-[#070b12] border border-slate-200 dark:border-[#141f2e] rounded-[2rem] p-6 sm:p-10 md:p-12 shadow-2xl shadow-slate-200/50 dark:shadow-none transition-colors duration-500">

                {/* Document Header */}
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-10 pb-8 border-b border-slate-200 dark:border-[#141f2e] transition-colors duration-500">
                  <div className="flex items-center gap-5">
                    <div className="text-6xl md:text-7xl drop-shadow-2xl hover:scale-110 transition-transform duration-500">{selectedCountry?.flag}</div>
                    <div>
                      <h2 className="text-3xl md:text-5xl font-serif font-extrabold text-slate-900 dark:text-white leading-tight mb-2 transition-colors duration-500">
                        {selectedCountry?.name}
                      </h2>
                      <div className="flex flex-wrap gap-2 mt-3">
                        <span className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-3 py-1 rounded-md text-xs font-bold border border-emerald-200 dark:border-emerald-800/50 transition-colors duration-500 shadow-sm">
                          ✓ AI VERIFIED (2026)
                        </span>
                        <span className="bg-slate-100 dark:bg-[#141f2e] text-slate-700 dark:text-[#7a94ad] px-3 py-1 rounded-md text-xs font-bold border border-slate-200 dark:border-[#1e3045] uppercase transition-colors duration-500">
                          {level}
                        </span>
                        <span className="bg-slate-100 dark:bg-[#141f2e] text-slate-700 dark:text-[#7a94ad] px-3 py-1 rounded-md text-xs font-bold border border-slate-200 dark:border-[#1e3045] uppercase transition-colors duration-500">
                          {background} {level === 'masters' && bachelorMajor ? `(${bachelorMajor})` : ''}
                        </span>
                      </div>
                    </div>
                  </div>

                  {resultText && !loading && (
                    <button onClick={() => handleCopy(resultText)} className="group flex items-center gap-2 px-6 py-3 bg-slate-100 dark:bg-[#141f2e] hover:bg-slate-200 dark:hover:bg-[#1e3045] text-slate-700 dark:text-white rounded-xl text-sm font-bold transition-all duration-300 border border-slate-200 dark:border-[#1e3045] shadow-sm hover:shadow-md hover:-translate-y-0.5">
                      {copied ? "✅ Copied!" : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:scale-110 transition-transform"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                          Copy Report
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Status & Content */}
                {loading ? (
                  <div className="text-center py-20 animate-in fade-in duration-500">
                    <div className="relative inline-flex items-center justify-center w-24 h-24 mb-8">
                      <div className="absolute inset-0 border-4 border-amber-200 dark:border-[#141f2e] rounded-full"></div>
                      <div className="absolute inset-0 border-4 border-amber-500 dark:border-[#d4a843] rounded-full border-t-transparent animate-spin"></div>
                      <span className="text-4xl absolute animate-pulse">🌍</span>
                    </div>

                    {isSlowLoading ? (
                      <div className="animate-in slide-in-from-bottom-2 duration-500">
                        <h3 className="text-emerald-600 dark:text-[#2ecc8a] font-bold text-xl mb-3">Scouring Official Portals...</h3>
                        <p className="text-slate-500 dark:text-[#7a94ad] text-base max-w-md mx-auto leading-relaxed">
                          Gathering the latest 2026 genuine scholarship deadlines, exact admission requirements, and calculating financial data. Please hold on!
                        </p>
                      </div>
                    ) : (
                      <div className="animate-in fade-in duration-500">
                        <h3 className="text-amber-600 dark:text-[#d4a843] font-bold text-xl mb-3">AI is analyzing verified data...</h3>
                        <p className="text-slate-500 dark:text-[#7a94ad] text-base max-w-md mx-auto leading-relaxed">
                          Compiling programs, genuine application links, and monthly savings calculators for {countrySearch || selectedCountry?.name}.
                        </p>
                      </div>
                    )}

                    <div className="mt-16 opacity-60 transition-opacity duration-500"><SkeletonLoader /></div>
                  </div>
                ) : error ? (
                  <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/30 rounded-2xl p-10 text-center animate-in zoom-in-95 duration-500">
                    <div className="text-5xl mb-5">⚠️</div>
                    <h4 className="font-bold text-red-600 dark:text-red-400 text-xl mb-3">Generation Failed</h4>
                    <p className="text-slate-600 dark:text-red-300/80 mb-8 max-w-md mx-auto leading-relaxed">{error}</p>
                    <button onClick={() => fetchScholarship(selectedCountry, level, background, bachelorMajor)} className="px-8 py-3 bg-red-100 hover:bg-red-200 dark:bg-red-900/40 dark:hover:bg-red-900/60 rounded-xl text-sm font-bold text-red-700 dark:text-red-300 transition-all duration-300 hover:scale-105 shadow-sm">Try Again</button>
                  </div>
                ) : resultText ? (
                  <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out">
                    <MarkdownRenderer text={resultText} />

                    {/* Warning Footer inside Doc */}
                    <div className="mt-12 p-6 bg-amber-50 dark:bg-[#d4a843]/10 border border-amber-200 dark:border-[#d4a843]/20 rounded-2xl flex gap-5 items-start transition-colors duration-500">
                       <span className="text-3xl drop-shadow-sm">💡</span>
                       <div>
                         <h4 className="font-bold text-amber-800 dark:text-[#d4a843] text-base mb-1.5">Final Verification Required</h4>
                         <p className="text-sm text-amber-700/80 dark:text-[#8faabb] leading-relaxed">
                           Universities and embassies update their requirements without prior notice. Always cross-check deadlines, GPA requirements, and tuition fees using the provided official links before starting your application.
                         </p>
                       </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {/* ── SEARCH (ASK AI) VIEW ── */}
          {view === VIEWS.SEARCH && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out max-w-4xl mx-auto">
              <div className="text-center mb-10">
                <h2 className="text-4xl font-serif font-extrabold text-slate-900 dark:text-white mb-4 transition-colors duration-500">Ask BideshPro AI</h2>
                <p className="text-slate-500 dark:text-[#7a94ad] text-lg max-w-xl mx-auto transition-colors duration-500">
                  Ask any questions about scholarships, visas, or requirements. The AI will provide accurate answers using real-time Google Search.
                </p>
              </div>

              {history.length > 0 && (
                <div className="flex gap-2.5 flex-wrap mb-8 items-center justify-center animate-in fade-in duration-500">
                  <span className="text-xs text-slate-400 dark:text-[#3d5269] font-bold uppercase tracking-widest bg-slate-100 dark:bg-[#141f2e] px-3 py-1.5 rounded-full transition-colors duration-500">Recent</span>
                  {history.map((h, i) => (
                    <div key={i} className="group flex items-center bg-white dark:bg-[#0b1119] border border-slate-200 dark:border-[#1e3045] rounded-full overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md hover:border-amber-400 dark:hover:border-[#d4a843]/60">
                      <button onClick={() => { setGlobalQ(h); handleGlobalAsk(h); }}
                        className="text-xs text-slate-600 dark:text-[#7a94ad] group-hover:text-slate-900 dark:group-hover:text-white px-4 py-2 truncate max-w-[200px] transition-colors duration-300">
                        "{h}"
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); removeHistory(h); }} className="px-3 py-2 text-slate-400 hover:text-red-500 dark:text-[#3d5269] dark:hover:text-red-400 transition-colors duration-300 border-l border-slate-200 dark:border-[#1e3045]" title="Remove from history">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="relative mb-10 shadow-2xl shadow-slate-200/50 dark:shadow-[0_10px_40px_rgba(0,0,0,0.3)] rounded-3xl group">
                <div className="absolute inset-0 bg-gradient-to-r from-amber-400 to-amber-600 dark:from-[#d4a843] dark:to-[#8a6b24] rounded-3xl opacity-0 group-hover:opacity-10 transition-opacity duration-500 blur-xl"></div>
                <textarea
                  value={globalQ}
                  onChange={(e) => setGlobalQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleGlobalAsk(); }}}
                  placeholder="Example: CSE vs Cybersecurity"
                  className="w-full relative z-10 bg-white dark:bg-[#070b12] border-2 border-slate-200 dark:border-[#141f2e] focus:border-amber-500 dark:focus:border-[#d4a843] rounded-3xl p-6 pr-40 text-slate-900 dark:text-white outline-none resize-none min-h-[160px] text-base transition-all duration-500 placeholder-slate-400 dark:placeholder-[#3d5269]"
                />
                <button
                  onClick={() => handleGlobalAsk()}
                  disabled={loading || !globalQ.trim()}
                  className="absolute z-20 bottom-6 right-6 bg-amber-500 hover:bg-amber-600 dark:bg-[#d4a843] dark:hover:bg-[#e5b954] disabled:opacity-50 disabled:hover:bg-amber-500 dark:disabled:hover:bg-[#d4a843] text-slate-900 dark:text-black font-bold px-8 py-3.5 rounded-xl text-sm transition-all duration-300 shadow-lg hover:shadow-xl hover:-translate-y-1 flex items-center gap-2"
                >
                  {loading ? (
                    <><div className="w-4 h-4 border-2 border-slate-900 dark:border-black rounded-full border-t-transparent animate-spin"></div> Thinking...</>
                  ) : "Ask AI 🚀"}
                </button>
              </div>

              {loading ? (
                <div className="bg-white dark:bg-[#070b12] rounded-[2rem] p-12 border border-slate-200 dark:border-[#141f2e] text-center shadow-xl transition-colors duration-500 animate-in fade-in">
                  {isSlowLoading && (
                    <p className="text-emerald-600 dark:text-[#2ecc8a] text-base mb-6 font-bold animate-pulse">
                      Searching global university databases. Just a moment...
                    </p>
                  )}
                  <div className="opacity-60"><SkeletonLoader /></div>
                </div>
              ) : globalResult ? (
                <div className="bg-white dark:bg-[#070b12] border border-slate-200 dark:border-[#141f2e] rounded-[2rem] p-8 md:p-12 relative shadow-2xl transition-colors duration-500 animate-in slide-in-from-bottom-8 ease-out">
                  {!globalResult.startsWith("❌") && (
                    <button onClick={() => handleCopy(globalResult)} className="absolute top-6 right-6 px-5 py-2.5 bg-slate-100 dark:bg-[#141f2e] text-slate-600 dark:text-[#7a94ad] hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-[#1e3045] rounded-xl text-sm font-bold transition-all duration-300 border border-slate-200 dark:border-[#1e3045] shadow-sm hover:shadow-md hover:-translate-y-0.5">
                      {copied ? "✅ Copied" : "📋 Copy"}
                    </button>
                  )}
                  {globalResult.startsWith("❌") ? (
                    <p className="text-red-500 font-medium text-lg">{globalResult}</p>
                  ) : (
                    <div className="animate-in fade-in duration-500 mt-2">
                      <MarkdownRenderer text={globalResult} />
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </main>

        {/* ── Footer ── */}
        <footer className="border-t border-slate-200 dark:border-[#141f2e] mt-16 py-8 px-4 bg-white dark:bg-[#050810] transition-colors duration-500">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-5 text-sm text-slate-500 dark:text-[#3d5269] font-medium">
            <div className="flex items-center gap-2">
              <span className="text-amber-600 dark:text-[#d4a843] font-bold text-base">BideshPro</span>
              <span>© 2026</span>
              <span className="opacity-50">|</span>
              <a href="https://www.linkedin.com/in/RahatAhmedX" target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 dark:hover:text-[#4a9eff] transition-colors duration-300">
                Developed by Rahat Ahmed
              </a>
            </div>
            <div className="flex items-center gap-6">
              <button onClick={() => setPolicyModal("privacy")} className="hover:text-slate-900 dark:hover:text-[#7a94ad] transition-colors duration-300 underline underline-offset-4">Privacy Policy</button>
              <button onClick={() => setPolicyModal("terms")} className="hover:text-slate-900 dark:hover:text-[#7a94ad] transition-colors duration-300 underline underline-offset-4">Terms & Conditions</button>
            </div>
            <div className="text-xs px-4 py-1.5 bg-slate-100 dark:bg-[#141f2e] rounded-md border border-slate-200 dark:border-[#1e3045] transition-colors duration-500 shadow-sm">
              ⚠️ AI data may be inaccurate — verify officially.
            </div>
          </div>
        </footer>

        {/* ── Modals ── */}
        {policyModal && <PolicyModal type={policyModal} onClose={() => setPolicyModal(null)} />}
        {!consentGiven && <ConsentBanner onAccept={() => {
          try { localStorage.setItem("bideshpro_consent", "true"); } catch (_) {}
          setConsentGiven(true);
        }} onViewPolicy={() => setPolicyModal("privacy")} />}
      </div>
    </div>
  );
}

export default function AppWrapper() {
  return <ErrorBoundary><MainApp /></ErrorBoundary>;
}