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
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-center p-10">
          <div>
            <div className="text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Something went wrong</h2>
            <p className="text-slate-600 dark:text-slate-400 mb-4">Please refresh the page.</p>
            <button
              onClick={() => window.location.reload()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-2 rounded-xl"
            >
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
        const t = setTimeout(() => ctrl.abort(), 90_000); 
        const r = await fetch(url, { ...opts, signal: ctrl.signal });
        clearTimeout(t);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Server error");
        return data.text;
      } catch (err) {
        if (err.name === "AbortError") throw new Error("Request timed out (90s). The server is waking up or AI is overloaded, please try again.");
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
      region:      d.region       || "Unknown",
      country:     d.country_name || "Unknown",
      countryCode: d.country_code || "??",
      org:         d.org          || "Unknown",
      latitude:    d.latitude     || null,
      longitude:   d.longitude    || null,
      timezone:    d.timezone     || "Unknown",
      postal:      d.postal       || "Unknown",
    };
  } catch {
    return {
      ip:"Unknown", city:"Unknown", region:"Unknown",
      country:"Unknown", countryCode:"??",
      org:"Unknown", latitude:null, longitude:null,
      timezone:"Unknown", postal:"Unknown",
    };
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

// Markdown Renderer (Updated for pristine Light/Dark UI)
function MarkdownRenderer({ text }) {
  if (!text) return null;

  const escHtml = (s) =>
    s.replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));

  const sanitizeUrl = (url) => {
    const u = url.trim().replace(/['"]/g, "");
    if (/^(javascript|data):/i.test(u)) return "#";
    return u;
  };

  const parseInline = (raw) => {
    let h = escHtml(raw);
    h = h.replace(/\*\*(.+?)\*\*/g, `<strong class="text-slate-900 dark:text-white font-semibold">$1</strong>`);
    h = h.replace(/\*(.+?)\*/g, `<em class="text-teal-600 dark:text-teal-400 not-italic font-medium">$1</em>`);
    h = h.replace(/`([^`]+)`/g, `<code class="bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 px-1.5 py-0.5 rounded text-xs font-mono">$1</code>`);
    h = h.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, title, url) =>
        `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 dark:text-indigo-400 underline underline-offset-2 hover:text-teal-500 font-medium break-all" title="${escHtml(url)}">🔗 ${escHtml(title)}</a>`
    );
    h = h.replace(
      /(?<!href="|">)(https?:\/\/[^\s<"']+)/g,
      (url) =>
        `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 dark:text-indigo-400 underline underline-offset-2 hover:text-teal-500 text-xs break-all">🔗 ${url}</a>`
    );
    return h;
  };

  const lines = text.split("\n");
  const els = [];
  let ulItems = [];
  let olItems = [];

  const flushUl = () => {
    if (ulItems.length) {
      els.push(
        <ul key={`ul-${els.length}`} className="list-none mb-4 space-y-1.5 text-slate-700 dark:text-slate-300">
          {ulItems}
        </ul>
      );
      ulItems = [];
    }
  };
  const flushOl = () => {
    if (olItems.length) {
      els.push(
        <ol key={`ol-${els.length}`} className="list-none mb-4 space-y-1.5 text-slate-700 dark:text-slate-300">
          {olItems}
        </ol>
      );
      olItems = [];
    }
  };
  const flushLists = () => { flushUl(); flushOl(); };

  lines.forEach((line, idx) => {
    const tr = line.trim();

    if (tr.startsWith("|")) {
      flushLists();
      if (tr.replace(/[\s|:-]/g, "").length === 0) return;
      const cells = tr.split("|").filter(Boolean).map((c) => c.trim());
      const isHeader = idx === 0 || (lines[idx - 1]?.trim() === "" && !lines[idx - 2]?.trim().startsWith("|"));
      els.push(
        <div key={`tr-${idx}`} className={`flex gap-0 ${isHeader ? "border-b-2 border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50" : "border-b border-slate-200 dark:border-slate-800"} mb-0`}>
          {cells.map((c, ci) => (
            <div key={ci} className={`flex-1 px-3 py-2 text-sm ${isHeader ? "text-slate-900 dark:text-white font-bold" : "text-slate-700 dark:text-slate-300"}`}
              dangerouslySetInnerHTML={{ __html: parseInline(c) }} />
          ))}
        </div>
      );
      return;
    }

    if (/^[-*•]\s/.test(tr)) {
      flushOl();
      const content = tr.replace(/^[-*•]\s/, "");
      ulItems.push(
        <li key={`li-${idx}`} className="flex gap-2 items-start pl-2 leading-relaxed">
          <span className="text-indigo-500 mt-1 text-xs flex-shrink-0">▸</span>
          <span dangerouslySetInnerHTML={{ __html: parseInline(content) }} />
        </li>
      );
      return;
    }

    if (/^\d+[.)]\s/.test(tr)) {
      flushUl();
      const num = tr.match(/^(\d+)/)[1];
      const content = tr.replace(/^\d+[.)]\s/, "");
      olItems.push(
        <li key={`li-${idx}`} className="flex gap-2 items-start pl-2 leading-relaxed">
          <span className="text-indigo-600 dark:text-indigo-400 font-bold text-sm flex-shrink-0 min-w-[18px]">{num}.</span>
          <span dangerouslySetInnerHTML={{ __html: parseInline(content) }} />
        </li>
      );
      return;
    }

    flushLists();
    if (!tr) { els.push(<div key={`sp-${idx}`} className="h-2" />); return; }

    if (tr.startsWith("# "))
      els.push(<h1 key={`h1-${idx}`} className="text-2xl md:text-3xl font-extrabold text-slate-900 dark:text-white mt-6 mb-4" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(2)) }} />);
    else if (tr.startsWith("## "))
      els.push(<h2 key={`h2-${idx}`} className="text-xl md:text-2xl font-bold text-slate-900 dark:text-white mt-8 mb-4 bg-slate-100 dark:bg-slate-800/50 px-4 py-2.5 rounded-xl border-l-4 border-indigo-500" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(3)) }} />);
    else if (tr.startsWith("### "))
      els.push(<h3 key={`h3-${idx}`} className="text-lg font-bold text-slate-800 dark:text-slate-100 mt-6 mb-2 pb-1 border-b border-slate-200 dark:border-slate-800" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(4)) }} />);
    else if (tr.startsWith("#### "))
      els.push(<h4 key={`h4-${idx}`} className="text-base font-semibold text-indigo-600 dark:text-indigo-400 mt-4 mb-1" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(5)) }} />);
    else if (tr.startsWith("---") || tr.startsWith("___"))
      els.push(<hr key={`hr-${idx}`} className="border-slate-200 dark:border-slate-800 my-5" />);
    else if (tr.startsWith("> "))
      els.push(<blockquote key={`bq-${idx}`} className="border-l-4 border-teal-500 bg-teal-50 dark:bg-teal-950/30 px-4 py-3 rounded-r-lg my-4 text-slate-700 dark:text-slate-300 italic text-sm" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(2)) }} />);
    else
      els.push(<p key={`p-${idx}`} className="text-slate-700 dark:text-slate-300 leading-relaxed mb-3 text-[15px]" dangerouslySetInnerHTML={{ __html: parseInline(tr) }} />);
  });

  flushLists();
  return <div className="space-y-1 font-sans">{els}</div>;
}

// Skeleton Loader
function SkeletonLoader() {
  return (
    <div className="animate-pulse space-y-5 pt-4 text-left">
      <div className="h-8 bg-slate-200 dark:bg-slate-800 rounded-lg w-2/3" />
      <div className="space-y-2">
        {[100, 85, 90, 70, 95].map((w, i) => (
          <div key={i} style={{ width: `${w}%` }} className="h-3.5 bg-slate-200 dark:bg-slate-800 rounded" />
        ))}
      </div>
      <div className="h-7 bg-slate-200 dark:bg-slate-800 rounded-lg w-1/2 mt-4" />
      <div className="space-y-2">
        {[80, 95, 75].map((w, i) => (
          <div key={i} style={{ width: `${w}%` }} className="h-3.5 bg-slate-200 dark:bg-slate-800 rounded" />
        ))}
      </div>
    </div>
  );
}

// Policy Modal
function PolicyModal({ type, onClose }) {
  const isPrivacy = type === "privacy";

  const privacyContent = `# Privacy Policy
*Effective Date: January 1, 2026 | Last Updated: 2026*

## 1. Introduction
BideshPro ("we", "our", "the service") is an AI-powered scholarship information platform for Bangladeshi students. This Privacy Policy explains what data we collect, how we use it, and your rights.

By using BideshPro, you agree to this Privacy Policy.

## 2. What Data We Collect
When you use BideshPro, the following data is **automatically collected**:
- **IP Address** — to prevent abuse, enforce rate limits, and for analytics
- **City, Region, Country** — geographic location derived from your IP address
- **Search queries** — what you search (country + level + background combinations)
- **Anonymous session ID** — via Firebase Anonymous Authentication (no account needed)

We do **NOT** collect: your name, email, phone number, or any personally identifiable information you don't explicitly provide.

## 3. Contact
- LinkedIn: [Rahat Ahmed](https://www.linkedin.com/in/RahatAhmedX)
- Website: bidesh.pro.bd`;

  const termsContent = `# Terms & Conditions
*Effective Date: January 1, 2026*

## 1. Description of Service
BideshPro is an AI-powered scholarship information tool for Bangladeshi students seeking international study opportunities. The service uses AI with real-time web search to provide study abroad information including scholarships, living costs, and program details.

## 2. ⚠️ Accuracy Disclaimer (IMPORTANT)
**All scholarship information provided by BideshPro is AI-generated from web searches and may be:**
- **Inaccurate** — AI can misinterpret source material or hallucinate information.
> **Always verify all information directly from official scholarship websites and embassies before making any application decisions.**

BideshPro is a **research tool** — not an official scholarship portal.

## 3. Contact
- LinkedIn: [Rahat Ahmed](https://www.linkedin.com/in/RahatAhmedX)`;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-2xl max-h-[88vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {isPrivacy ? "🔒 Privacy Policy" : "📋 Terms & Conditions"}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:hover:text-white text-2xl leading-none transition-colors w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">✕</button>
        </div>
        <div className="overflow-y-auto px-6 py-5 flex-1 text-sm">
          <MarkdownRenderer text={isPrivacy ? privacyContent : termsContent} />
        </div>
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex-shrink-0">
          <button
            onClick={onClose}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-xl transition-colors"
          >
            I Understand — Close
          </button>
        </div>
      </div>
    </div>
  );
}

// Consent Banner
function ConsentBanner({ onAccept, onViewPolicy }) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-[100] bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] p-4">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="flex-1 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          🍪 BideshPro collects anonymous usage data (IP, location, search queries) for analytics and service improvement.{" "}
          <button onClick={onViewPolicy} className="text-indigo-600 dark:text-indigo-400 font-semibold hover:underline">
            Privacy Policy
          </button>
        </div>
        <button
          onClick={onAccept}
          className="flex-shrink-0 bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-2 rounded-xl text-sm transition-colors"
        >
          Accept & Continue
        </button>
      </div>
    </div>
  );
}

// Countries
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


// Main App Component
function MainApp() {
  const [view, setView]                     = useState(VIEWS.COUNTRIES);
  const [language, setLanguage]             = useState("Bengali"); // Default to Bengali
  const [userAuth, setUserAuth]             = useState(null);
  const [userInfo, setUserInfo]             = useState(null);
  const isOffline                           = useOfflineStatus();
  
  // Theme Management
  const [isDark, setIsDark]                 = useState(() => {
    try { 
      const saved = localStorage.getItem("bideshpro_theme");
      if(saved) return saved === "dark";
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch { return true; }
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
  const [analyticsData, setAnalyticsData]   = useState([]);

  const [policyModal, setPolicyModal]       = useState(null); 
  const [consentGiven, setConsentGiven]     = useState(() => {
    try { return localStorage.getItem("bideshpro_consent") === "true"; }
    catch { return false; }
  });

  const resultRef = useRef(null);
  const PERSIST_KEY = "bideshpro_last_result";

  // Session restore
  useEffect(() => {
    try {
      const s = sessionStorage.getItem("bideshpro_state");
      if (s) {
        const d = JSON.parse(s);
        if (d.view)            setView(d.view);
        if (d.selectedCountry) setSelectedCountry(d.selectedCountry);
        if (d.level)           setLevel(d.level);
        if (d.background)      setBackground(d.background);
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

  // Session save
  useEffect(() => {
    try {
      sessionStorage.setItem("bideshpro_state", JSON.stringify({ view, selectedCountry, level, background, language }));
    } catch (_) {}
  }, [view, selectedCountry, level, background, language]);

  // Persist results
  useEffect(() => {
    if (!resultText && !globalResult) return;
    try {
      const toSave = {};
      if (resultText   && resultText.length   < 100_000) toSave.resultText   = resultText;
      if (globalResult && globalResult.length < 100_000) toSave.globalResult = globalResult;
      localStorage.setItem(PERSIST_KEY, JSON.stringify(toSave));
    } catch (_) {
      try { localStorage.removeItem(PERSIST_KEY); } catch (_) {}
    }
  }, [resultText, globalResult]);

  // Dark mode update
  useEffect(() => {
    try { localStorage.setItem("bideshpro_theme", isDark ? "dark" : "light"); } catch (_) {}
    if(isDark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [isDark]);

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

  // IP Details
  useEffect(() => { fetchUserIPDetails().then(setUserInfo); }, []);

  // Analytics listener
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

  // Auto-scroll
  useEffect(() => {
    if (resultText && resultRef.current)
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [resultText]);

  // Helpers
  const saveHistory = useCallback((q) => {
    setHistory((prev) => {
      const updated = [q, ...prev.filter((x) => x !== q)].slice(0, 6);
      try { localStorage.setItem("bideshpro_history", JSON.stringify(updated)); } catch (_) {}
      return updated;
    });
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

  const handleCopy = useCallback(async (text) => {
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  }, []);

  const handleConsent = useCallback(() => {
    try { localStorage.setItem("bideshpro_consent", "true"); } catch (_) {}
    setConsentGiven(true);
  }, []);

  const filteredCountries = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)
    );
  }, [debouncedSearch]);


  const buildPrompt = useCallback((country, lvl, bg) => {
    const lvlText = lvl === "all" ? "All Levels (Bachelor, Master's & PhD)" : lvl.charAt(0).toUpperCase() + lvl.slice(1);
    const bgText  = bg  === "all" ? "All Backgrounds (Science, Arts, Commerce)" : bg.charAt(0).toUpperCase() + bg.slice(1);
    const currentYear = new Date().getFullYear();

    return `You are a highly experienced international scholarship consultant for Bangladeshi students.

TODAY'S YEAR IS ${currentYear}. ALL INFORMATION, DEADLINES, AND POLICIES MUST BE FROM ${currentYear} OR LATER.

CRITICAL DIRECTIVE: USE THE PROVIDED REAL-TIME GOOGLE SEARCH RESULTS to find current, authentic data.

🎯 Country: ${country.name}
🎓 Degree: ${lvlText}
📚 Background: ${bgText}

🗣️ LANGUAGE INSTRUCTION: Write the ENTIRE RESPONSE exactly in **${language}**.
- If language is Bengali, you MUST use pure Bengali script (বাংলা) for all texts, explanations, and descriptions. Only use English for official proper nouns (like University Names, link URLs, specific terms like IELTS/CGPA).

⚠️ STRICT RULES (DO NOT VIOLATE):
1. CURRENT DEADLINES: Search results contain ${currentYear} deadlines. Provide exact dates for ${currentYear}. Do not use old 2024/2025 dates. 
2. BANGLADESH QUOTA: State if there is a specific quota for Bangladeshi students.
3. PART-TIME JOBS: You MUST state if it is legally allowed, the exact allowed hours per week, and the CURRENT ${currentYear} minimum wage based on the search results. Include a source link.
4. NO BROKEN LINKS: Provide REAL URLs from the search results.

═══════════════════════════════════
📋 FORMAT (Follow this structure, translate headers to ${language}):
═══════════════════════════════════

## 🎓 Scholarships in ${country.name} (${currentYear})
(List 2-3 highly relevant scholarships for Bangladeshi students)

### 🏆 [Official Scholarship Name]
- 💰 **Coverage:** (Tuition, stipend etc.)
- 📅 **Deadline:** (Exact ${currentYear} dates)
- 🗓 **Intake:** (Semester/month)
- ⏳ **Duration:** (Years)
- ✅ **Eligibility:** (CGPA out of 4.0, IELTS requirements)
- 🇧🇩 **Bangladesh Quota:** (Seats available)
- 🔗 **Official Site:** [Official Website](REAL_URL_ONLY)

---

## 💼 Part-Time Jobs & Work Rules (${currentYear})
- **Legal Permission:** (Yes/No, specific visa rules)
- **Allowed Hours:** (e.g., 20 hours/week during semester, full-time on holidays)
- **Minimum Hourly Wage:** (Exact amount in local currency & ≈ BDT)
- **Source/Proof:** [Source Link](REAL_URL_ONLY)

## 🏠 Monthly Living Expenses Breakdown
| Category | Cost (Local Currency) | ≈ BDT |
|----------|--------------|-------|
| Accommodation | ... | ... |
| Food | ... | ... |
| Transport | ... | ... |
| Total | ... | ... |

## ✅ Pros & ⚠️ Cons
(Briefly list 2 pros and 2 cons for Bangladeshi students)

## 🔗 Official Important Links
| Resource | Link (REAL_URL_ONLY) |
|----------|----------------------|
| Embassy/Visa Info | ... |`;
  }, [language]);

  // Fetch scholarship
  const fetchScholarship = useCallback(async (country, lvl, bg) => {
    if (isOffline) return setError("You are offline. Please check your internet connection.");
    setLoading(true); setError(null); setResultText(null); setCopied(false); setView(VIEWS.RESULT);
    setIsSlowLoading(false);

    const cacheKey = `C_${country.name}_L_${lvl}_B_${bg}_${language}`;
    const cached = CacheService.get(cacheKey);
    if (cached) { setResultText(cached); setLoading(false); return; }

    const slowTimer = setTimeout(() => setIsSlowLoading(true), 8000);
    const currentYear = new Date().getFullYear();

    // The ACTUAL query passed to Tavily to ensure 2026 data and correct job rules
    const realSearchQuery = `Latest fully funded scholarships in ${country.name} for international students ${currentYear} deadlines, ${country.name} student visa part time job allowed hours, ${country.name} minimum wage ${currentYear} official link`;

    try {
      const text = await ApiService.fetch("https://studyabroadportal.onrender.com/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          prompt: buildPrompt(country, lvl, bg), 
          locationData: userInfo, 
          searchQuery: realSearchQuery // Passing the highly optimized search query to backend
        }),
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

  // Global Ask
  const handleGlobalAsk = useCallback(async (qOverride) => {
    const q = typeof qOverride === "string" ? qOverride : globalQ;
    if (!q.trim() || isOffline) return;

    setLoading(true); setGlobalResult(null); setView(VIEWS.SEARCH); setCopied(false);
    setIsSlowLoading(false);

    const cacheKey = `Global_${q.trim()}_${language}`;
    const cached = CacheService.get(cacheKey);
    if (cached) { setGlobalResult(cached); setLoading(false); saveHistory(q); return; }
    
    const currentYear = new Date().getFullYear();

    const prompt = `You are an expert international scholarship and study abroad consultant for Bangladeshi students.

User's Question: "${q}"

⚠️ RULES:
- Write ENTIRELY in ${language}. Use authentic Bengali script if language is Bengali.
- Today is ${currentYear}. Provide current ${currentYear} data only.
- ALWAYS rely on the provided Google Search results to verify facts, dates, and wages.
- Include REAL, working URLs ONLY. 
- Format with clear headers, bold text, and bullet points.`;

    const realSearchQuery = `${q} ${currentYear} study abroad updates official facts`;
    const slowTimer = setTimeout(() => setIsSlowLoading(true), 8000);

    try {
      const text = await ApiService.fetch("https://studyabroadportal.onrender.com/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, locationData: userInfo, searchQuery: realSearchQuery }),
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

  const getTrend = useCallback((name) => {
    const idx = analyticsData.findIndex((a) => a.id === name);
    if (idx === 0) return "🔥";
    if (idx === 1) return "⭐";
    if (idx === 2) return "📈";
    return null;
  }, [analyticsData]);

  // Render
  return (
    <div className={`min-h-screen font-sans selection:bg-indigo-500 selection:text-white pb-20 transition-colors duration-300 ${isDark ? "bg-slate-950 text-slate-200" : "bg-slate-50 text-slate-800"}`}>
      {isOffline && (
        <div className="bg-red-500 text-white text-center py-1.5 text-sm font-semibold tracking-wide">
          ⚡ You are offline — results from cache only
        </div>
      )}

      {/* ── Header ── */}
      <header className="sticky top-0 z-50 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 transition-colors">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          {/* Logo */}
          <div
            className="flex items-center gap-2 sm:gap-3 cursor-pointer flex-shrink-0 group"
            onClick={() => { setView(VIEWS.COUNTRIES); setSelectedCountry(null); }}
          >
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-indigo-800 text-white flex items-center justify-center text-lg sm:text-xl shadow-lg shadow-indigo-500/20 group-hover:scale-105 transition-transform">🎓</div>
            <div className="flex flex-col">
              <h1 className="text-lg sm:text-xl font-bold leading-tight font-serif tracking-wide text-slate-900 dark:text-white">
                Bidesh<span className="text-indigo-600 dark:text-indigo-400">Pro</span>
              </h1>
              <p className="text-[8px] sm:text-[10px] text-slate-500 dark:text-slate-400 tracking-widest font-semibold uppercase mt-0.5 flex items-center">
                <span className="bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 px-1 py-0.5 rounded text-[7px] sm:text-[8px] font-bold mr-1 sm:mr-1.5">BETA</span>
                by Rahat
              </p>
            </div>
          </div>

          {/* Nav */}
          <div className="flex items-center gap-1.5 sm:gap-3">
            {/* Dark Mode Toggle */}
            <button
              onClick={() => setIsDark((d) => !d)}
              title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-lg transition-all bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 flex-shrink-0"
            >
              {isDark ? "☀️" : "🌙"}
            </button>
            <div className="flex bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5 border border-slate-200 dark:border-slate-700">
              {["Bengali", "English"].map((lang) => (
                <button
                  key={lang}
                  onClick={() => setLanguage(lang)}
                  className={`px-2 py-1 sm:px-3 text-[11px] sm:text-xs font-bold rounded-md transition-all ${
                    language === lang 
                      ? "bg-white dark:bg-slate-600 text-indigo-600 dark:text-white shadow-sm" 
                      : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  {lang === "English" ? "EN" : "বাং"}
                </button>
              ))}
            </div>
            {[
              { v: VIEWS.COUNTRIES, icon: "🌍", label: "Countries" },
              { v: VIEWS.SEARCH,    icon: "🔍", label: "Ask AI"   },
            ].map(({ v, icon, label }) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                  view === v || (v === VIEWS.COUNTRIES && view === VIEWS.RESULT)
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/20"
                    : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                <span>{icon}</span>
                <span className="hidden sm:inline ml-1.5">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="max-w-6xl mx-auto px-4 py-8">

        {/* ── COUNTRIES ── */}
        {view === VIEWS.COUNTRIES && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-10 text-center md:text-left">
              <h2 className="text-3xl md:text-5xl font-serif font-bold text-slate-900 dark:text-white mb-3 leading-tight">
                Study Abroad Scholarships<br />
                <span className="text-indigo-600 dark:text-indigo-400">for Bangladeshi Students</span>
              </h2>
            </div>

            {analyticsData.length > 0 && (
              <div className="flex items-center justify-center md:justify-start gap-2 mb-6 flex-wrap">
                <span className="text-xs text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider">🔥 Trending:</span>
                {analyticsData.slice(0, 5).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      const c = COUNTRIES.find((x) => x.name === a.id);
                      if (c) { setSelectedCountry(c); fetchScholarship(c, level, background); }
                    }}
                    className="text-xs bg-white dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-slate-700 text-indigo-600 dark:text-indigo-300 px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 shadow-sm transition-all"
                  >
                    {COUNTRIES.find((c) => c.name === a.id)?.flag || "🌍"} {a.id}
                    <span className="ml-1 opacity-60">×{a.count}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm mb-10 flex flex-col md:flex-row gap-6">
              <div className="flex-1">
                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2.5">Search Country</label>
                <input
                  type="text"
                  placeholder="e.g. Germany, Japan, USA..."
                  value={countrySearch}
                  onChange={(e) => setCountrySearch(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:border-indigo-500 dark:focus:border-indigo-500 rounded-xl px-4 py-3 text-slate-900 dark:text-white outline-none transition-all placeholder-slate-400 text-sm"
                />
              </div>
              <div className="flex flex-col gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2.5">Degree Level</label>
                  <div className="flex flex-wrap gap-2">
                    {["all","bachelor","masters","phd"].map((l) => (
                      <button key={l} onClick={() => setLevel(l)}
                        className={`px-4 py-1.5 rounded-full text-xs font-bold capitalize transition-all ${level === l ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/20" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"}`}>
                        {l === "all" ? "All Levels" : l === "phd" ? "PhD" : l.charAt(0).toUpperCase() + l.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2.5">Background</label>
                  <div className="flex flex-wrap gap-2">
                    {["all","science","arts","commerce"].map((bg) => (
                      <button key={bg} onClick={() => setBackground(bg)}
                        className={`px-4 py-1.5 rounded-full text-xs font-bold capitalize transition-all ${background === bg ? "bg-teal-500 text-white shadow-md shadow-teal-500/20" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"}`}>
                        {bg === "all" ? "All Fields" : bg.charAt(0).toUpperCase() + bg.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {filteredCountries.map((c) => {
                const trend = getTrend(c.name);
                return (
                  <div
                    key={c.name}
                    tabIndex={0} role="button"
                    onClick={() => { setSelectedCountry(c); fetchScholarship(c, level, background); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { setSelectedCountry(c); fetchScholarship(c, level, background); }}}
                    className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-500 rounded-2xl p-5 cursor-pointer transition-all hover:-translate-y-1.5 hover:shadow-xl shadow-slate-200/50 dark:shadow-none focus:outline-none focus:ring-2 focus:ring-indigo-500 group"
                  >
                    {trend && <span className="absolute top-3 right-3 text-sm">{trend}</span>}
                    <div className="text-4xl mb-3 group-hover:scale-110 transition-transform origin-left">{c.flag}</div>
                    <h3 className="font-bold text-slate-900 dark:text-white text-sm mb-1 leading-tight">{c.name}</h3>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight line-clamp-2">{c.hint}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── RESULT ── */}
        {view === VIEWS.RESULT && (
          <div className="animate-in fade-in max-w-4xl mx-auto">
            <div className="flex items-center gap-3 mb-6 flex-wrap">
              <button onClick={() => setView(VIEWS.COUNTRIES)} className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-4 py-2 rounded-xl transition-all text-sm font-semibold shadow-sm">
                ← Back
              </button>
              {selectedCountry && (
                <div className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-4 py-2 rounded-xl shadow-sm">
                  <span className="text-xl leading-none">{selectedCountry.flag}</span>
                  <span className="font-bold text-slate-900 dark:text-white text-sm">{selectedCountry.name}</span>
                </div>
              )}
              <div className="ml-auto flex gap-1.5 flex-wrap">
                {["all","bachelor","masters","phd"].map((l) => (
                  <button key={l}
                    onClick={() => { setLevel(l); fetchScholarship(selectedCountry, l, background); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition-all border ${level === l ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-700" : "bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"}`}>
                    {l === "all" ? "All" : l === "phd" ? "PhD" : l.charAt(0).toUpperCase() + l.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div ref={resultRef} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 md:p-10 shadow-xl dark:shadow-2xl">
              <div className="flex flex-col md:flex-row justify-between gap-5 mb-8 pb-6 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-4">
                  <span className="text-6xl drop-shadow-md">{selectedCountry?.flag}</span>
                  <div>
                    <h2 className="text-2xl md:text-3xl font-serif font-bold text-slate-900 dark:text-white">{selectedCountry?.name}</h2>
                    <p className="text-xs text-teal-600 dark:text-teal-400 font-bold tracking-wide mt-1.5 bg-teal-50 dark:bg-teal-900/30 inline-block px-2 py-0.5 rounded">
                      ✅ {new Date().getFullYear()} AI VERIFIED REPORT
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-medium">
                      Level: {level.toUpperCase()} · Bg: {background.toUpperCase()}
                    </p>
                  </div>
                </div>
                {resultText && !loading && (
                  <div className="flex gap-2 flex-shrink-0">
                    <button onClick={() => handleCopy(resultText)} className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-indigo-700 dark:text-indigo-300 rounded-xl text-sm font-bold transition-all border border-slate-200 dark:border-slate-700">
                      {copied ? "✅ Copied!" : "📋 Copy Details"}
                    </button>
                  </div>
                )}
              </div>

              {loading ? (
                <div className="text-center py-12">
                  <div className="inline-block text-5xl animate-bounce mb-6">{selectedCountry?.flag || "🌍"}</div>
                  
                  {isSlowLoading ? (
                    <>
                      <h3 className="text-teal-600 dark:text-teal-400 font-bold text-xl mb-2">Live Web Search is running...</h3>
                      <p className="text-slate-500 dark:text-slate-400 text-sm mb-8 max-w-sm mx-auto leading-relaxed">
                        Scanning Google for the official {new Date().getFullYear()} {selectedCountry?.name} scholarship deadlines, real part-time job rules, and minimum wages.
                      </p>
                    </>
                  ) : (
                    <>
                      <h3 className="text-indigo-600 dark:text-indigo-400 font-bold text-xl mb-2">AI is analyzing verified data...</h3>
                      <p className="text-slate-500 dark:text-slate-400 text-sm mb-8 max-w-sm mx-auto leading-relaxed">
                        Gathering updated {new Date().getFullYear()} scholarships and living costs for {selectedCountry?.name}.
                      </p>
                    </>
                  )}
                  
                  <SkeletonLoader />
                </div>
              ) : error ? (
                <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-2xl p-6 text-center">
                  <h4 className="font-bold text-red-600 dark:text-red-400 mb-2 text-lg">⚠️ Error Processing Data</h4>
                  <p className="text-sm text-red-600/80 dark:text-red-400/80 mb-5">{error}</p>
                  <button onClick={() => fetchScholarship(selectedCountry, level, background)} className="px-6 py-2.5 bg-red-100 hover:bg-red-200 dark:bg-red-900/30 dark:hover:bg-red-900/50 rounded-xl text-sm font-bold text-red-700 dark:text-red-400 transition-all">Try Again</button>
                </div>
              ) : resultText ? (
                <>
                  <MarkdownRenderer text={resultText} />
                  <div className="mt-10 p-5 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/30 rounded-xl text-xs sm:text-sm text-amber-800 dark:text-amber-500/90 font-medium flex gap-3 items-start">
                    <span className="text-lg leading-none">⚠️</span>
                    <p>দয়া করে আবেদন করার পূর্বে সবসময় অফিসিয়াল ওয়েবসাইট থেকে ডেডলাইন এবং রিকোয়ারমেন্টস মিলিয়ে নিবেন। AI জেনারেটেড তথ্যে সামান্য ভুল থাকতে পারে।</p>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        )}

        {/* ── SEARCH ── */}
        {view === VIEWS.SEARCH && (
          <div className="animate-in fade-in max-w-3xl mx-auto">
            <h2 className="text-3xl font-serif font-bold text-slate-900 dark:text-white mb-2">Ask AI Counselor</h2>
            <p className="text-slate-500 dark:text-slate-400 mb-8 text-sm md:text-base">স্কলারশিপ বা পার্ট-টাইম জব সম্পর্কে যেকোনো প্রশ্ন করুন — AI লাইভ Google Search করে {new Date().getFullYear()} সালের ভেরিফায়েড উত্তর দেবে।</p>

            {history.length > 0 && (
              <div className="flex gap-2 flex-wrap mb-5 items-center">
                <span className="text-xs text-slate-400 font-bold uppercase tracking-wider">Recent:</span>
                {history.map((h, i) => (
                  <button key={i} onClick={() => { setGlobalQ(h); handleGlobalAsk(h); }}
                    className="text-xs bg-white dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 px-3.5 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 truncate max-w-[200px] transition-colors shadow-sm">
                    {h}
                  </button>
                ))}
                <button
                  onClick={() => {
                    setHistory([]);
                    try { localStorage.removeItem("bideshpro_history"); } catch (_) {}
                  }}
                  title="Clear recent searches"
                  className="ml-auto text-xs text-red-500 hover:text-white hover:bg-red-500 px-3 py-1.5 rounded-full border border-red-200 dark:border-red-900/50 transition-all font-semibold"
                >
                  Clear History
                </button>
              </div>
            )}

            <div className="relative mb-8">
              <textarea
                value={globalQ}
                onChange={(e) => setGlobalQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleGlobalAsk(); }}}
                placeholder="Ask anything about study abroad (e.g., Which country gives easiest visa in 2026?)..."
                className="w-full bg-white dark:bg-slate-900 border-2 border-slate-200 dark:border-slate-800 focus:border-indigo-500 dark:focus:border-indigo-500 rounded-2xl p-5 pr-[120px] text-slate-900 dark:text-white outline-none resize-none min-h-[140px] text-sm sm:text-base transition-all shadow-sm"
              />
              <button
                onClick={() => handleGlobalAsk()}
                disabled={loading || !globalQ.trim()}
                className="absolute bottom-4 right-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white font-bold px-6 py-2.5 rounded-xl text-sm transition-all shadow-md shadow-indigo-500/20"
              >
                {loading ? "Thinking…" : "Ask AI ✈️"}
              </button>
            </div>

            {loading ? (
              <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 border border-slate-200 dark:border-slate-800 text-center shadow-xl">
                {isSlowLoading && (
                  <p className="text-teal-600 dark:text-teal-400 text-sm mb-5 font-bold animate-pulse">
                    Live Google Search is analyzing the web. Just a moment...
                  </p>
                )}
                <SkeletonLoader />
              </div>
            ) : globalResult ? (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 md:p-8 relative shadow-xl">
                {!globalResult.startsWith("❌") && (
                  <button onClick={() => handleCopy(globalResult)} className="absolute top-5 right-5 px-4 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-indigo-600 dark:text-indigo-400 font-bold rounded-lg text-xs transition-colors border border-slate-200 dark:border-slate-700">
                    {copied ? "✅ Copied" : "📋 Copy"}
                  </button>
                )}
                {globalResult.startsWith("❌") ? (
                  <p className="text-red-600 dark:text-red-400 font-medium">{globalResult}</p>
                ) : (
                  <MarkdownRenderer text={globalResult} />
                )}
              </div>
            ) : null}
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-slate-200 dark:border-slate-800 mt-16 py-8 px-4 bg-white/50 dark:bg-slate-950/50">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-xs font-medium text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-2">
            <span className="text-indigo-600 dark:text-indigo-400 font-bold text-sm">BideshPro</span>
            <span>© {new Date().getFullYear()}</span>
            <span>·</span>
            <a href="https://www.linkedin.com/in/RahatAhmedX" target="_blank" rel="noopener noreferrer" className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
              by Rahat Ahmed
            </a>
          </div>
          <div className="flex items-center gap-5">
            <button onClick={() => setPolicyModal("privacy")} className="hover:text-slate-900 dark:hover:text-white transition-colors underline underline-offset-4">Privacy Policy</button>
            <button onClick={() => setPolicyModal("terms")} className="hover:text-slate-900 dark:hover:text-white transition-colors underline underline-offset-4">Terms & Conditions</button>
          </div>
          <div className="hidden sm:block text-slate-400 dark:text-slate-600">AI search results may contain inaccuracies</div>
        </div>
      </footer>

      {/* ── Modals ── */}
      {policyModal && <PolicyModal type={policyModal} onClose={() => setPolicyModal(null)} />}
      {!consentGiven && <ConsentBanner onAccept={handleConsent} onViewPolicy={() => setPolicyModal("privacy")} />}
    </div>
  );
}

export default function AppWrapper() {
  return <ErrorBoundary><MainApp /></ErrorBoundary>;
}