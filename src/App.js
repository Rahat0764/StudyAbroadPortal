// App.js — BideshPro (Complete Replacement)
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

// ─── Constants ────────────────────────────────────────────────────────────────
const VIEWS = { COUNTRIES: "countries", SEARCH: "search", RESULT: "result" };
const CACHE_LIMIT = 25;

// ─── Firebase ─────────────────────────────────────────────────────────────────
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

// ─── Error Boundary ───────────────────────────────────────────────────────────
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
            <button
              onClick={() => window.location.reload()}
              className="bg-[#d4a843] text-black font-bold px-6 py-2 rounded-xl"
            >
              Refresh
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────
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

// ─── Services ─────────────────────────────────────────────────────────────────
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
        const t = setTimeout(() => ctrl.abort(), 38_000);
        const r = await fetch(url, { ...opts, signal: ctrl.signal });
        clearTimeout(t);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Server error");
        return data.text;
      } catch (err) {
        if (err.name === "AbortError") throw new Error("Request timed out (38s)");
        if (i === retries - 1) throw err;
        await new Promise((res) => setTimeout(res, 1200 * (i + 1)));
      }
    }
  },
};

// ─── IP Geolocation (full data) ───────────────────────────────────────────────
async function fetchUserIPDetails() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch("https://ipapi.co/json/", { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    return {
      ip:          d.ip          || "Unknown",
      city:        d.city        || "Unknown",
      region:      d.region      || "Unknown",
      country:     d.country_name || "Unknown",
      countryCode: d.country_code || "??",
      org:         d.org         || "Unknown",
      latitude:    d.latitude    || null,
      longitude:   d.longitude   || null,
      timezone:    d.timezone    || "Unknown",
      postal:      d.postal      || "Unknown",
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

// ─── Clipboard ────────────────────────────────────────────────────────────────
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

// ─── Markdown Renderer ────────────────────────────────────────────────────────
function MarkdownRenderer({ text }) {
  if (!text) return null;

  const escHtml = (s) =>
    s.replace(/[&<>'"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c]));

  const sanitizeUrl = (url) => {
    const u = url.trim().replace(/['"]/g, "");
    if (/^(javascript|data):/i.test(u)) return "#";
    return u;
  };

  const parseInline = (raw) => {
    let h = escHtml(raw);
    // Bold
    h = h.replace(/\*\*(.+?)\*\*/g, `<strong class="text-white font-semibold">$1</strong>`);
    // Italic
    h = h.replace(/\*(.+?)\*/g, `<em class="text-[#22c7b8] not-italic font-medium">$1</em>`);
    // Code
    h = h.replace(/`([^`]+)`/g, `<code class="bg-[#1a2a3a] text-[#4a9eff] px-1.5 py-0.5 rounded text-xs font-mono">$1</code>`);
    // Links with label [text](url)
    h = h.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, title, url) =>
        `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" ` +
        `class="text-[#4a9eff] underline underline-offset-2 hover:text-[#2ecc8a] font-medium break-all" ` +
        `title="${escHtml(url)}">🔗 ${escHtml(title)}</a>`
    );
    // Bare URLs (not already inside <a>)
    h = h.replace(
      /(?<!href="|">)(https?:\/\/[^\s<"']+)/g,
      (url) =>
        `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" ` +
        `class="text-[#4a9eff] underline underline-offset-2 hover:text-[#2ecc8a] text-xs break-all">🔗 ${url}</a>`
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
        <ul key={`ul-${els.length}`} className="list-none mb-4 space-y-1.5 text-[#7a94ad]">
          {ulItems}
        </ul>
      );
      ulItems = [];
    }
  };
  const flushOl = () => {
    if (olItems.length) {
      els.push(
        <ol key={`ol-${els.length}`} className="list-none mb-4 space-y-1.5 text-[#7a94ad]">
          {olItems}
        </ol>
      );
      olItems = [];
    }
  };
  const flushLists = () => { flushUl(); flushOl(); };

  lines.forEach((line, idx) => {
    const tr = line.trim();

    // Tables (simple 2-col)
    if (tr.startsWith("|")) {
      flushLists();
      if (tr.replace(/[\s|:-]/g, "").length === 0) return; // separator row
      const cells = tr.split("|").filter(Boolean).map((c) => c.trim());
      const isHeader = idx === 0 || (lines[idx - 1]?.trim() === "" && !lines[idx - 2]?.trim().startsWith("|"));
      els.push(
        <div key={`tr-${idx}`} className={`flex gap-0 ${isHeader ? "border-b border-[#1e3045]" : "border-b border-[#141f2e]/50"} mb-0`}>
          {cells.map((c, ci) => (
            <div
              key={ci}
              className={`flex-1 px-3 py-2 text-sm ${isHeader ? "text-[#d4a843] font-semibold" : "text-[#7a94ad]"}`}
              dangerouslySetInnerHTML={{ __html: parseInline(c) }}
            />
          ))}
        </div>
      );
      return;
    }

    // Unordered list
    if (/^[-*•]\s/.test(tr)) {
      flushOl();
      const content = tr.replace(/^[-*•]\s/, "");
      ulItems.push(
        <li key={`li-${idx}`} className="flex gap-2 items-start pl-2 leading-relaxed">
          <span className="text-[#d4a843] mt-1 text-xs flex-shrink-0">▸</span>
          <span dangerouslySetInnerHTML={{ __html: parseInline(content) }} />
        </li>
      );
      return;
    }

    // Ordered list
    if (/^\d+[.)]\s/.test(tr)) {
      flushUl();
      const num = tr.match(/^(\d+)/)[1];
      const content = tr.replace(/^\d+[.)]\s/, "");
      olItems.push(
        <li key={`li-${idx}`} className="flex gap-2 items-start pl-2 leading-relaxed">
          <span className="text-[#d4a843] font-bold text-sm flex-shrink-0 min-w-[18px]">{num}.</span>
          <span dangerouslySetInnerHTML={{ __html: parseInline(content) }} />
        </li>
      );
      return;
    }

    flushLists();

    if (!tr) { els.push(<div key={`sp-${idx}`} className="h-2" />); return; }

    if (tr.startsWith("# "))
      els.push(<h1 key={`h1-${idx}`} className="text-3xl font-extrabold text-[#d4a843] mt-6 mb-4 font-serif" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(2)) }} />);
    else if (tr.startsWith("## "))
      els.push(
        <h2 key={`h2-${idx}`}
          className="text-2xl font-extrabold text-white mt-8 mb-4 bg-gradient-to-r from-[#f0c96622] to-transparent px-4 py-2.5 rounded-xl border-l-4 border-[#d4a843]"
          dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(3)) }} />
      );
    else if (tr.startsWith("### "))
      els.push(
        <h3 key={`h3-${idx}`}
          className="text-lg font-bold text-[#d4a843] mt-6 mb-2 pb-1 border-b border-[#141f2e]"
          dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(4)) }} />
      );
    else if (tr.startsWith("#### "))
      els.push(
        <h4 key={`h4-${idx}`}
          className="text-base font-semibold text-[#4a9eff] mt-4 mb-1"
          dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(5)) }} />
      );
    else if (tr.startsWith("---") || tr.startsWith("___"))
      els.push(<hr key={`hr-${idx}`} className="border-[#141f2e] my-4" />);
    else if (tr.startsWith("> "))
      els.push(
        <blockquote key={`bq-${idx}`}
          className="border-l-4 border-[#d4a843]/50 bg-[#0c1520] px-4 py-2 rounded-r-lg my-3 text-[#7a94ad] italic text-sm"
          dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(2)) }} />
      );
    else
      els.push(
        <p key={`p-${idx}`}
          className="text-[#8faabb] leading-relaxed mb-2 text-sm"
          dangerouslySetInnerHTML={{ __html: parseInline(tr) }} />
      );
  });

  flushLists();
  return <div className="space-y-0.5 font-sans">{els}</div>;
}

// ─── Skeleton Loader ──────────────────────────────────────────────────────────
function SkeletonLoader() {
  return (
    <div className="animate-pulse space-y-5 pt-4">
      <div className="h-8 bg-[#141f2e] rounded-lg w-2/3" />
      <div className="space-y-2">
        {[100, 85, 90, 70, 95].map((w, i) => (
          <div key={i} className={`h-3.5 bg-[#141f2e] rounded w-[${w}%]`} />
        ))}
      </div>
      <div className="h-7 bg-[#141f2e] rounded-lg w-1/2 mt-4" />
      <div className="space-y-2">
        {[80, 95, 75].map((w, i) => (
          <div key={i} className={`h-3.5 bg-[#141f2e] rounded w-[${w}%]`} />
        ))}
      </div>
    </div>
  );
}

// ─── Policy Modal ─────────────────────────────────────────────────────────────
function PolicyModal({ type, onClose }) {
  const isPrivacy = type === "privacy";
  const title = isPrivacy ? "Privacy Policy" : "Terms & Conditions";

  const privacyContent = `
## What We Collect
When you use BideshPro, the following data is automatically collected:

- **IP Address** — to prevent abuse and for analytics
- **City, Region, Country** — geographic location derived from IP
- **ISP / Organization** — internet service provider name
- **Coordinates (Lat/Lon)** — approximate location for analytics
- **Timezone & Postal Code** — from IP geolocation
- **Search queries** — what you search to improve service quality
- **Anonymous session ID** — via Firebase Anonymous Auth

## How We Use This Data
- **Service analytics** — understanding which countries/scholarships are most searched
- **Abuse prevention** — rate limiting and blocking malicious requests
- **Service improvement** — improving AI prompt quality based on usage patterns
- **Internal logging** — logs are stored in our monitoring system

## Third-Party Services
BideshPro uses these third-party services, each with their own privacy policies:

- **Google Gemini AI** (ai.google.dev) — processes your search queries
- **Google Search** — Gemini uses Google Search to find real-time info
- **ipapi.co** — IP geolocation service
- **Firebase (Google)** — anonymous authentication and analytics
- **Vercel** — hosting provider

## Data Retention
Search logs and IP data are retained for up to **90 days** for analytics and abuse prevention, after which they are permanently deleted.

## Your Rights
You have the right to:
- Use the service without creating an account
- Know what data is collected (this policy)
- Stop using the service at any time

## No Sale of Data
We do not sell, rent, or trade your personal data to any third party.

## Children
This service is not intended for users under 13 years of age.

## Contact
For privacy concerns, contact the developer via the LinkedIn link in the header.

## Updates
This policy may be updated periodically. Continued use of the service implies acceptance.

*Last updated: 2025*
`;

  const termsContent = `
## 1. Acceptance of Terms
By using BideshPro, you agree to these Terms & Conditions. If you disagree, please stop using the service.

## 2. Service Description
BideshPro is an AI-powered scholarship information tool for Bangladeshi students. It uses Google Gemini AI with real-time web search to provide study abroad information.

## 3. Accuracy Disclaimer
⚠️ **IMPORTANT:** All scholarship information provided by BideshPro is AI-generated from web searches and may be:

- **Outdated** — scholarship deadlines and requirements change every year
- **Incomplete** — not all scholarships may be listed
- **Inaccurate** — AI can make mistakes in interpreting source material

**Always verify information directly from official scholarship websites before applying.**

## 4. No Professional Advice
BideshPro does not provide:
- Official legal or immigration advice
- Guaranteed scholarship application guidance
- Professional financial advice

Use this service for **research purposes only**.

## 5. Limitation of Liability
BideshPro and its developer(s) are not liable for:
- Any decisions made based on AI-generated content
- Missed scholarship deadlines
- Rejected applications
- Financial losses

## 6. Acceptable Use
You agree NOT to:
- Use automated scripts or bots to scrape the service
- Attempt to reverse-engineer or exploit the API
- Share your API access with others
- Use the service for any illegal purpose

## 7. Service Availability
BideshPro is provided "as is" without warranty. We do not guarantee:
- 100% uptime
- Accuracy of AI responses
- Availability of any specific scholarship

## 8. Intellectual Property
All branding, design, and code of BideshPro are owned by the developer. AI-generated content is provided for personal, non-commercial use only.

## 9. Changes to Terms
These terms may be updated at any time. Continued use constitutes acceptance.

## 10. Governing Law
These terms are governed by the laws of Bangladesh.

*Last updated: 2025*
`;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-[#070b12] border border-[#1e3045] rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#141f2e] flex-shrink-0">
          <h2 className="text-lg font-bold text-white font-serif">{title}</h2>
          <button onClick={onClose} className="text-[#7a94ad] hover:text-white text-2xl leading-none transition-colors">✕</button>
        </div>
        <div className="overflow-y-auto px-6 py-5 flex-1 text-sm">
          <MarkdownRenderer text={isPrivacy ? privacyContent : termsContent} />
        </div>
        <div className="px-6 py-4 border-t border-[#141f2e] flex-shrink-0">
          <button
            onClick={onClose}
            className="w-full bg-[#d4a843] text-black font-bold py-2.5 rounded-xl hover:bg-[#e5b954] transition-colors"
          >
            I Understand — Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Consent Banner ───────────────────────────────────────────────────────────
function ConsentBanner({ onAccept, onViewPolicy }) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-[100] bg-[#070b12] border-t border-[#1e3045] shadow-2xl p-4">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex-1 text-sm text-[#7a94ad]">
          🍪 BideshPro collects anonymous usage data (IP, location, search queries) for analytics and service improvement.
          {" "}
          <button onClick={onViewPolicy} className="text-[#4a9eff] underline hover:text-[#2ecc8a]">
            Privacy Policy
          </button>
        </div>
        <button
          onClick={onAccept}
          className="flex-shrink-0 bg-[#d4a843] text-black font-bold px-6 py-2 rounded-xl text-sm hover:bg-[#e5b954] transition-colors"
        >
          Accept & Continue
        </button>
      </div>
    </div>
  );
}

// ─── Countries List ───────────────────────────────────────────────────────────
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

// ─── Main App ─────────────────────────────────────────────────────────────────
function MainApp() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [view, setView]                     = useState(VIEWS.COUNTRIES);
  const [language, setLanguage]             = useState("English");
  const [userAuth, setUserAuth]             = useState(null);
  const [userInfo, setUserInfo]             = useState(null);
  const isOffline                           = useOfflineStatus();

  const [selectedCountry, setSelectedCountry] = useState(null);
  const [level, setLevel]                   = useState("all");
  const [background, setBackground]         = useState("all");
  const [countrySearch, setCountrySearch]   = useState("");
  const debouncedSearch                     = useDebounce(countrySearch, 280);

  const [resultText, setResultText]         = useState(null);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState(null);
  const [copied, setCopied]                 = useState(false);

  const [globalQ, setGlobalQ]               = useState("");
  const [globalResult, setGlobalResult]     = useState(null);
  const [history, setHistory]               = useState([]);
  const [analyticsData, setAnalyticsData]   = useState([]);

  const [policyModal, setPolicyModal]       = useState(null); // "privacy" | "terms" | null
  const [consentGiven, setConsentGiven]     = useState(() => {
    try { return localStorage.getItem("bideshpro_consent") === "true"; }
    catch { return false; }
  });

  const resultRef = useRef(null);

  // ── Session restore ────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const s = sessionStorage.getItem("bideshpro_state");
      if (s) {
        const d = JSON.parse(s);
        if (d.view)            setView(d.view);
        if (d.selectedCountry) setSelectedCountry(d.selectedCountry);
        if (d.resultText)      setResultText(d.resultText);
        if (d.level)           setLevel(d.level);
        if (d.background)      setBackground(d.background);
        if (d.language)        setLanguage(d.language);
      }
      const h = localStorage.getItem("bideshpro_history");
      if (h) setHistory(JSON.parse(h));
    } catch (_) {}
  }, []);

  // ── Session save ───────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const state = { view, selectedCountry, level, background, language };
      // Only cache result if < 80KB to avoid storage quota issues
      if (resultText && resultText.length < 80_000) state.resultText = resultText;
      sessionStorage.setItem("bideshpro_state", JSON.stringify(state));
    } catch (_) {
      try { sessionStorage.removeItem("bideshpro_state"); } catch (_) {}
    }
  }, [view, selectedCountry, resultText, level, background, language]);

  // ── Firebase Auth ──────────────────────────────────────────────────────────
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

  // ── IP Details ─────────────────────────────────────────────────────────────
  useEffect(() => { fetchUserIPDetails().then(setUserInfo); }, []);

  // ── Analytics listener ─────────────────────────────────────────────────────
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

  // ── Scroll to result ───────────────────────────────────────────────────────
  useEffect(() => {
    if (resultText && resultRef.current)
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [resultText]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const saveHistory = useCallback((q) => {
    setHistory((prev) => {
      const updated = [q, ...prev.filter((x) => x !== q)].slice(0, 6);
      // side effect outside render
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

  // ── Filtered countries ─────────────────────────────────────────────────────
  const filteredCountries = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)
    );
  }, [debouncedSearch]);

  // ── Build prompt ───────────────────────────────────────────────────────────
  const buildPrompt = useCallback(
    (country, lvl, bg) => {
      const lvlText = lvl === "all" ? "All Levels (Bachelor, Master's & PhD)" : lvl.charAt(0).toUpperCase() + lvl.slice(1);
      const bgText  = bg  === "all" ? "All Backgrounds (Science, Arts, Commerce)" : bg.charAt(0).toUpperCase() + bg.slice(1);

      return `You are a highly experienced international scholarship consultant specializing in helping Bangladeshi students study abroad.

Provide COMPREHENSIVE, ACCURATE, and CURRENT information for:
🎯 Country: ${country.name}
🎓 Degree Level: ${lvlText}
📚 Academic Background: ${bgText}
🌐 Output Language: ${language}

⚠️ CRITICAL RULES:
1. If level is "bachelor", ONLY show bachelor-level scholarships — no Masters or PhD programs.
2. EVERY scholarship MUST have its official application portal link.
3. Write ENTIRELY in ${language} language.
4. Include REAL, working URLs only — do not fabricate links.
5. Always include Bangladesh-specific quota/seat information where available.

═══════════════════════════════════
📋 REQUIRED SECTIONS (use these exact headers):
═══════════════════════════════════

## 🎓 Scholarships in ${country.name}

For EACH scholarship, use this format:

### 🏆 [Official Scholarship Name]
- 💰 **Coverage:** (tuition + stipend amount in local currency AND USD + accommodation + airfare + insurance)
- 📅 **Deadline:** (specific month/date)
- 🗓 **Intake:** (semester/month)
- ⏳ **Duration:** (by level)
- ✅ **Eligibility:**
  - Age: ...
  - SSC GPA (out of 5.0): ...
  - HSC GPA (out of 5.0): ...
  - Bachelor CGPA (out of 4.0): ...
  - Work experience: ...
  - Backgrounds: Science / Arts / Commerce
- 📄 **Required Documents:** (complete list)
- 🗣 **Language:** (English/local + test requirement e.g. IELTS score)
- 🇧🇩 **Bangladesh Quota:** (exact number of seats if available)
- 🔗 **Official Site:** [name](URL)
- 📝 **Apply Here:** [portal name](URL)
- 💡 **Tip for Bangladeshi Students:** ...

---

## 📚 Available Programs (${bgText} at ${lvlText})
(List subjects/fields available)

## 🗣 Language of Instruction
(English-taught programs vs local language — specify ratios)

## 💼 Part-Time Jobs for International Students
- Legal working hours per week: ...
- Average hourly wage: ... (local currency + BDT equivalent)
- Monthly earning potential: ...
- Popular job sectors for students: ...

## 🏠 Monthly Living Expenses Breakdown
| Category | Estimated Cost (Local) | ≈ BDT |
|----------|----------------------|-------|
| Accommodation | ... | ... |
| Food & Groceries | ... | ... |
| Transport | ... | ... |
| Internet + Phone | ... | ... |
| Miscellaneous | ... | ... |
| **Total** | **...** | **...** |

## 📊 Financial Feasibility
(Scholarship amount + part-time income − living expenses = monthly savings/deficit?)

## ✅ Pros of Studying in ${country.name}
(Specific, honest advantages for Bangladeshi students)

## ⚠️ Cons & Challenges
(Visa rejection rates, language difficulty, degree recognition, cultural challenges, blocked money requirements if any)

## 🔗 All Important Links
| Resource | Link |
|----------|------|
| Bangladesh Embassy | ... |
| Student Visa Portal | ... |
| Scholarship Official | ... |
| Student Community/Forum | ... |

Use Google Search to find the most current information. Include actual URLs wherever possible.`;
    },
    [language]
  );

  // ── Fetch country scholarships ─────────────────────────────────────────────
  const fetchScholarship = useCallback(
    async (country, lvl, bg) => {
      if (isOffline) return setError("You are offline. Please check your internet connection.");
      setLoading(true);
      setError(null);
      setResultText(null);
      setCopied(false);
      setView(VIEWS.RESULT);

      const cacheKey = `C_${country.name}_L_${lvl}_B_${bg}_${language}`;
      const cached = CacheService.get(cacheKey);
      if (cached) { setResultText(cached); setLoading(false); return; }

      try {
        const text = await ApiService.fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt:       buildPrompt(country, lvl, bg),
            locationData: userInfo,
            searchQuery:  cacheKey,
          }),
        });
        CacheService.set(cacheKey, text);
        setResultText(text);
        updateAnalytics(country.name);
      } catch (err) {
        const msg = err.message;
        setError(
          msg.includes("Unexpected token") || msg.includes("not found")
            ? "⚠️ Backend API not connected. Deploy to Vercel and set environment variables."
            : msg
        );
      } finally {
        setLoading(false);
      }
    },
    [userInfo, updateAnalytics, isOffline, language, buildPrompt]
  );

  // ── Global Ask ─────────────────────────────────────────────────────────────
  const handleGlobalAsk = useCallback(
    async (qOverride) => {
      const q = typeof qOverride === "string" ? qOverride : globalQ;
      if (!q.trim() || isOffline) return;

      setLoading(true);
      setGlobalResult(null);
      setView(VIEWS.SEARCH);
      setCopied(false);

      const cacheKey = `Global_${q.trim()}_${language}`;
      const cached = CacheService.get(cacheKey);
      if (cached) { setGlobalResult(cached); setLoading(false); saveHistory(q); return; }

      const prompt = `You are an expert international scholarship and study abroad consultant for Bangladeshi students.

Answer this question comprehensively with verified, current information:

"${q}"

⚠️ Rules:
- Write entirely in ${language}
- Include REAL, working URLs for all scholarships and portals mentioned
- Include Bangladesh-specific quota/seat info where available
- Mention SSC/HSC GPA (out of 5.0) and CGPA (out of 4.0) requirements
- Format with clear headers and bullet points
- Include official deadlines and application portals
- Use Google Search to verify current information

Format response with emojis and clear sections. Always end with a "🔗 Useful Links" section listing all official URLs mentioned.`;

      try {
        const text = await ApiService.fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, locationData: userInfo, searchQuery: cacheKey }),
        });
        CacheService.set(cacheKey, text);
        setGlobalResult(text);
        saveHistory(q);
      } catch (err) {
        setGlobalResult("❌ Error: " + err.message);
      } finally {
        setLoading(false);
      }
    },
    [globalQ, userInfo, isOffline, language, saveHistory]
  );

  // ── Trending badges helper ─────────────────────────────────────────────────
  const getTrend = useCallback(
    (name) => {
      const idx = analyticsData.findIndex((a) => a.id === name);
      if (idx === 0) return "🔥";
      if (idx === 1) return "⭐";
      if (idx === 2) return "📈";
      return null;
    },
    [analyticsData]
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#03050a] text-[#dde6f0] font-sans selection:bg-[#d4a843] selection:text-black pb-20">
      {/* Offline banner */}
      {isOffline && (
        <div className="bg-red-600 text-white text-center py-1.5 text-sm font-semibold tracking-wide">
          ⚡ You are offline — results from cache only
        </div>
      )}

      {/* ── Header ── */}
      <header className="sticky top-0 z-50 bg-[#050810]/95 backdrop-blur-md border-b border-[#141f2e]">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          {/* Logo */}
          <div
            className="flex items-center gap-3 cursor-pointer flex-shrink-0"
            onClick={() => { setView(VIEWS.COUNTRIES); setSelectedCountry(null); }}
          >
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#d4a843] to-[#8a6b24] flex items-center justify-center text-xl shadow-lg flex-shrink-0">
              🎓
            </div>
            <div className="hidden sm:block">
              <h1 className="text-xl font-bold leading-tight font-serif tracking-wide">
                <span className="text-white">Bidesh</span>
                <span className="text-[#d4a843]">Pro</span>
              </h1>
              <p className="text-[10px] text-[#7a94ad] tracking-widest font-semibold uppercase flex items-center gap-1">
                <span className="bg-[#d4a843] text-black px-1.5 py-0.5 rounded text-[8px] font-bold">BETA</span>
                <a
                  href="https://www.linkedin.com/in/RahatAhmedX"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#4a9eff] hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  by Rahat
                </a>
              </p>
            </div>
          </div>

          {/* Nav */}
          <div className="flex items-center gap-2">
            {/* Lang toggle */}
            <div className="flex bg-[#141f2e] rounded-lg p-0.5 border border-[#1e3045]">
              {["English", "Bengali"].map((lang) => (
                <button
                  key={lang}
                  onClick={() => setLanguage(lang)}
                  className={`px-2.5 py-1 text-[11px] font-bold rounded-md transition-all ${
                    language === lang ? "bg-[#d4a843] text-black" : "text-[#7a94ad] hover:text-white"
                  }`}
                >
                  {lang === "English" ? "EN" : "বাং"}
                </button>
              ))}
            </div>

            {/* View buttons */}
            {[
              { v: VIEWS.COUNTRIES, icon: "🌍", label: "Countries" },
              { v: VIEWS.SEARCH,    icon: "🔍", label: "Ask AI" },
            ].map(({ v, icon, label }) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  view === v || (v === VIEWS.COUNTRIES && view === VIEWS.RESULT)
                    ? "bg-[#d4a843] text-black shadow-sm"
                    : "text-[#7a94ad] hover:text-white hover:bg-[#141f2e]"
                }`}
              >
                <span>{icon}</span>
                <span className="hidden sm:inline ml-1">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="max-w-6xl mx-auto px-4 py-8">

        {/* ── COUNTRIES VIEW ── */}
        {view === VIEWS.COUNTRIES && (
          <div className="animate-in fade-in duration-300">
            {/* Hero */}
            <div className="mb-10">
              <h2 className="text-3xl md:text-5xl font-serif font-bold text-white mb-3 leading-tight">
                Study Abroad Scholarships
                <br />
                <span className="text-[#d4a843]">for Bangladeshi Students</span>
              </h2>
              <p className="text-[#7a94ad] max-w-2xl text-base md:text-lg leading-relaxed">
                AI ইন্টারনেট সার্চ করে প্রোগ্রাম, স্কলারশিপ, পার্ট-টাইম জব এবং
                লিভিং এক্সপেন্সের verified তথ্য দেবে — সরাসরি official link সহ।
              </p>
            </div>

            {/* Trending row */}
            {analyticsData.length > 0 && (
              <div className="flex items-center gap-2 mb-5 flex-wrap">
                <span className="text-xs text-[#3d5269] font-semibold uppercase tracking-wider">🔥 Trending:</span>
                {analyticsData.slice(0, 5).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      const c = COUNTRIES.find((x) => x.name === a.id);
                      if (c) { setSelectedCountry(c); fetchScholarship(c, level, background); }
                    }}
                    className="text-xs bg-[#141f2e] hover:bg-[#1e3045] text-[#d4a843] px-3 py-1 rounded-full border border-[#1e3045] transition-colors"
                  >
                    {COUNTRIES.find((c) => c.name === a.id)?.flag || "🌍"} {a.id}
                    <span className="ml-1 text-[#3d5269]">×{a.count}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Filters */}
            <div className="bg-[#070b12] border border-[#141f2e] rounded-2xl p-5 mb-8 flex flex-col md:flex-row gap-5">
              <div className="flex-1">
                <label className="block text-xs font-bold text-[#3d5269] uppercase tracking-wider mb-2">
                  Search Country
                </label>
                <input
                  type="text"
                  placeholder="e.g. Germany, Japan, Saudi..."
                  value={countrySearch}
                  onChange={(e) => setCountrySearch(e.target.value)}
                  className="w-full bg-[#0b1119] border border-[#141f2e] focus:border-[#d4a843] rounded-xl px-4 py-3 text-white outline-none transition-all placeholder-[#3d5269] text-sm"
                />
              </div>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#3d5269] uppercase tracking-wider mb-2">
                    Degree Level
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {["all", "bachelor", "masters", "phd"].map((l) => (
                      <button
                        key={l}
                        onClick={() => setLevel(l)}
                        className={`px-4 py-1.5 rounded-full text-xs font-semibold capitalize transition-all ${
                          level === l ? "bg-[#d4a843] text-black" : "bg-[#141f2e]/60 text-[#7a94ad] hover:bg-[#141f2e]"
                        }`}
                      >
                        {l === "all" ? "All Levels" : l === "phd" ? "PhD" : l.charAt(0).toUpperCase() + l.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#3d5269] uppercase tracking-wider mb-2">
                    Background
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {["all", "science", "arts", "commerce"].map((bg) => (
                      <button
                        key={bg}
                        onClick={() => setBackground(bg)}
                        className={`px-4 py-1.5 rounded-full text-xs font-semibold capitalize transition-all ${
                          background === bg ? "bg-[#d4a843] text-black" : "bg-[#141f2e]/60 text-[#7a94ad] hover:bg-[#141f2e]"
                        }`}
                      >
                        {bg === "all" ? "All" : bg.charAt(0).toUpperCase() + bg.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Grid */}
            {filteredCountries.length === 0 ? (
              <div className="text-center py-16 bg-[#070b12] rounded-2xl border border-[#141f2e]">
                <span className="text-4xl mb-3 block">🌍</span>
                <h3 className="text-lg text-white font-bold">No country found</h3>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {filteredCountries.map((c) => {
                  const trend = getTrend(c.name);
                  return (
                    <div
                      key={c.name}
                      tabIndex={0}
                      role="button"
                      aria-label={`Select ${c.name}`}
                      onClick={() => { setSelectedCountry(c); fetchScholarship(c, level, background); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { setSelectedCountry(c); fetchScholarship(c, level, background); } }}
                      className="relative bg-[#0b1119] border border-[#141f2e] hover:border-[#d4a843]/60 rounded-2xl p-4 cursor-pointer transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-[#d4a843]/5 focus:outline-none focus:border-[#d4a843] group"
                    >
                      {trend && (
                        <span className="absolute top-2 right-2 text-xs">{trend}</span>
                      )}
                      <div className="text-3xl mb-2 group-hover:scale-110 transition-transform origin-left">{c.flag}</div>
                      <h3 className="font-bold text-white text-sm mb-1 leading-tight">{c.name}</h3>
                      <p className="text-[10px] text-[#3d5269] leading-tight line-clamp-2">{c.hint}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── RESULT VIEW ── */}
        {view === VIEWS.RESULT && (
          <div className="animate-in fade-in max-w-4xl mx-auto">
            {/* Back + refresh */}
            <div className="flex items-center gap-3 mb-6 flex-wrap">
              <button
                onClick={() => setView(VIEWS.COUNTRIES)}
                className="flex items-center gap-1 text-[#7a94ad] hover:text-white px-3 py-1.5 rounded-lg hover:bg-[#141f2e] transition-all text-sm"
              >
                ← Back
              </button>
              {selectedCountry && (
                <div className="flex items-center gap-2">
                  <span className="text-3xl">{selectedCountry.flag}</span>
                  <span className="font-bold text-white text-lg font-serif">{selectedCountry.name}</span>
                </div>
              )}
              {/* Quick level switch */}
              <div className="ml-auto flex gap-1.5 flex-wrap">
                {["all", "bachelor", "masters", "phd"].map((l) => (
                  <button
                    key={l}
                    onClick={() => { setLevel(l); fetchScholarship(selectedCountry, l, background); }}
                    className={`px-3 py-1 rounded-full text-xs font-semibold capitalize transition-all ${
                      level === l ? "bg-[#d4a843] text-black" : "bg-[#141f2e] text-[#7a94ad] hover:text-white"
                    }`}
                  >
                    {l === "all" ? "All" : l === "phd" ? "PhD" : l.charAt(0).toUpperCase() + l.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Result Card */}
            <div ref={resultRef} className="bg-[#070b12] border border-[#141f2e] rounded-3xl p-6 md:p-10 shadow-2xl">
              {/* Card header */}
              <div className="flex flex-col md:flex-row justify-between gap-5 mb-8 pb-6 border-b border-[#141f2e]">
                <div className="flex items-center gap-4">
                  <span className="text-5xl">{selectedCountry?.flag}</span>
                  <div>
                    <h2 className="text-2xl md:text-3xl font-serif font-bold text-white">{selectedCountry?.name}</h2>
                    <p className="text-xs text-[#d4a843] font-medium tracking-wide mt-1">
                      AI VERIFIED REPORT · Level: {level.toUpperCase()} · Background: {background.toUpperCase()}
                    </p>
                  </div>
                </div>
                {resultText && !loading && (
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleCopy(resultText)}
                      className="px-4 py-2 bg-[#141f2e] hover:bg-[#1e3045] text-white rounded-xl text-sm font-medium transition-all"
                    >
                      {copied ? "✅ Copied!" : "📋 Copy"}
                    </button>
                    <button
                      onClick={() => fetchScholarship(selectedCountry, level, background)}
                      className="px-4 py-2 bg-[#1e3045] hover:bg-[#2a4060] text-[#4a9eff] rounded-xl text-sm font-medium transition-all"
                    >
                      🔄 Refresh
                    </button>
                  </div>
                )}
              </div>

              {/* Content */}
              {loading ? (
                <div className="text-center py-10">
                  <div className="inline-block text-5xl animate-spin mb-5">🌍</div>
                  <h3 className="text-[#d4a843] font-bold text-lg mb-2">
                    AI is searching for verified data...
                  </h3>
                  <p className="text-[#7a94ad] text-sm mb-6">
                    Analyzing scholarships, jobs & living costs for {selectedCountry?.name}
                  </p>
                  <SkeletonLoader />
                </div>
              ) : error ? (
                <div className="bg-[#1a0a0a] border border-[#e05555]/30 rounded-2xl p-6">
                  <h4 className="font-bold text-[#e05555] mb-2">⚠️ Error</h4>
                  <p className="text-sm text-[#e05555]/80 mb-4">{error}</p>
                  <button
                    onClick={() => fetchScholarship(selectedCountry, level, background)}
                    className="px-5 py-2 bg-[#e05555]/20 hover:bg-[#e05555]/30 rounded-xl text-sm text-[#e05555] transition-all"
                  >
                    Retry
                  </button>
                </div>
              ) : resultText ? (
                <>
                  <MarkdownRenderer text={resultText} />
                  <div className="mt-8 p-4 bg-[#d4a843]/8 border border-[#d4a843]/25 rounded-xl text-xs text-[#7a94ad]">
                    ⚠️ <strong className="text-[#dde6f0]">Disclaimer:</strong> AI-generated content may not reflect the latest updates.
                    Always verify deadlines and requirements from official scholarship websites before applying.
                  </div>
                </>
              ) : null}
            </div>
          </div>
        )}

        {/* ── SEARCH VIEW ── */}
        {view === VIEWS.SEARCH && (
          <div className="animate-in fade-in max-w-3xl mx-auto">
            <h2 className="text-3xl font-serif font-bold text-white mb-2">Ask AI Counselor</h2>
            <p className="text-[#7a94ad] mb-6 text-sm">
              স্কলারশিপ সম্পর্কে যেকোনো প্রশ্ন করুন — AI Google Search করে verified উত্তর দেবে।
            </p>

            {/* History chips */}
            {history.length > 0 && (
              <div className="flex gap-2 flex-wrap mb-4 items-center">
                <span className="text-xs text-[#3d5269] font-semibold">Recent:</span>
                {history.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => { setGlobalQ(h); handleGlobalAsk(h); }}
                    className="text-xs bg-[#141f2e] hover:bg-[#1e3045] text-[#7a94ad] hover:text-white px-3 py-1.5 rounded-full transition-colors border border-[#1e3045] max-w-[180px] truncate"
                  >
                    {h}
                  </button>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="relative mb-6">
              <textarea
                value={globalQ}
                onChange={(e) => setGlobalQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleGlobalAsk(); } }}
                placeholder={
                  language === "Bengali"
                    ? "উদাহরণ: কমার্স ব্যাকগ্রাউন্ড থেকে ইউরোপে ব্যাচেলর স্কলারশিপ কোথায় পাওয়া যাবে?"
                    : "Ex: Which countries offer fully funded bachelor scholarships for Commerce students?"
                }
                className="w-full bg-[#070b12] border border-[#141f2e] focus:border-[#d4a843] rounded-2xl p-5 pr-28 text-white outline-none resize-none min-h-[120px] text-sm transition-all"
              />
              <button
                onClick={() => handleGlobalAsk()}
                disabled={loading || !globalQ.trim()}
                className="absolute bottom-4 right-4 bg-[#d4a843] hover:bg-[#e5b954] disabled:opacity-40 text-black font-bold px-5 py-2.5 rounded-xl text-sm transition-all"
              >
                {loading ? "Thinking…" : "Ask →"}
              </button>
            </div>

            {/* Result */}
            {loading ? (
              <div className="bg-[#070b12] rounded-2xl p-8 border border-[#141f2e]">
                <SkeletonLoader />
              </div>
            ) : globalResult ? (
              <div className="bg-[#070b12] border border-[#141f2e] rounded-2xl p-6 md:p-8 relative shadow-xl">
                {!globalResult.startsWith("❌") && (
                  <button
                    onClick={() => handleCopy(globalResult)}
                    className="absolute top-4 right-4 px-3 py-1 bg-[#141f2e] text-[#7a94ad] hover:text-white rounded-lg text-xs transition-colors"
                  >
                    {copied ? "✅" : "📋 Copy"}
                  </button>
                )}
                {globalResult.startsWith("❌") ? (
                  <p className="text-[#e05555] text-sm">{globalResult}</p>
                ) : (
                  <>
                    <MarkdownRenderer text={globalResult} />
                    <div className="mt-6 p-3 bg-[#d4a843]/8 border border-[#d4a843]/20 rounded-lg text-xs text-[#7a94ad]">
                      ⚠️ Always verify information from official sources before applying.
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-[#141f2e] mt-12 py-8 px-4">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-xs text-[#3d5269]">
          <div className="flex items-center gap-3">
            <span className="text-[#d4a843] font-bold text-sm">BideshPro</span>
            <span>© 2025</span>
            <span>·</span>
            <a
              href="https://www.linkedin.com/in/RahatAhmedX"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#4a9eff] transition-colors"
            >
              by Rahat Ahmed
            </a>
          </div>
          <div className="flex gap-4">
            <button onClick={() => setPolicyModal("privacy")} className="hover:text-[#4a9eff] transition-colors">
              Privacy Policy
            </button>
            <button onClick={() => setPolicyModal("terms")} className="hover:text-[#4a9eff] transition-colors">
              Terms & Conditions
            </button>
            <span className="text-[#141f2e]">|</span>
            <span className="text-[#1e3045]">AI data may be inaccurate — verify before applying</span>
          </div>
        </div>
      </footer>

      {/* ── Policy Modal ── */}
      {policyModal && <PolicyModal type={policyModal} onClose={() => setPolicyModal(null)} />}

      {/* ── Consent Banner ── */}
      {!consentGiven && (
        <ConsentBanner
          onAccept={handleConsent}
          onViewPolicy={() => setPolicyModal("privacy")}
        />
      )}
    </div>
  );
}

export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}
