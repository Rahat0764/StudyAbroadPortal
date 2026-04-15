// App.js — BideshPro
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

// ── Firebase ───────────────────────────────────────────────────────────────────
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

// ── Error Boundary ─────────────────────────────────────────────────────────────
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

// ── Hooks ──────────────────────────────────────────────────────────────────────
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

// ── Services ───────────────────────────────────────────────────────────────────
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
        const t = setTimeout(() => ctrl.abort(), 60_000); 
        const r = await fetch(url, { ...opts, signal: ctrl.signal });
        clearTimeout(t);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Server error");
        return data.text;
      } catch (err) {
        if (err.name === "AbortError") throw new Error("Request timed out (60s)");
        if (i === retries - 1) throw err;
        await new Promise((res) => setTimeout(res, 1200 * (i + 1)));
      }
    }
  },
};

// ── IP Geolocation ─────────────────────────────────────────────────────────────
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

// ── Clipboard ──────────────────────────────────────────────────────────────────
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

// ── Markdown Renderer ──────────────────────────────────────────────────────────
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
    h = h.replace(/\*\*(.+?)\*\*/g, `<strong class="text-white font-semibold">$1</strong>`);
    h = h.replace(/\*(.+?)\*/g, `<em class="text-[#22c7b8] not-italic font-medium">$1</em>`);
    h = h.replace(/`([^`]+)`/g, `<code class="bg-[#1a2a3a] text-[#4a9eff] px-1.5 py-0.5 rounded text-xs font-mono">$1</code>`);
    h = h.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, title, url) =>
        `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" class="text-[#4a9eff] underline underline-offset-2 hover:text-[#2ecc8a] font-medium break-all" title="${escHtml(url)}">🔗 ${escHtml(title)}</a>`
    );
    h = h.replace(
      /(?<!href="|">)(https?:\/\/[^\s<"']+)/g,
      (url) =>
        `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" class="text-[#4a9eff] underline underline-offset-2 hover:text-[#2ecc8a] text-xs break-all">🔗 ${url}</a>`
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

    // Table rows
    if (tr.startsWith("|")) {
      flushLists();
      if (tr.replace(/[\s|:-]/g, "").length === 0) return;
      const cells = tr.split("|").filter(Boolean).map((c) => c.trim());
      const isHeader = idx === 0 || (lines[idx - 1]?.trim() === "" && !lines[idx - 2]?.trim().startsWith("|"));
      els.push(
        <div key={`tr-${idx}`} className={`flex gap-0 ${isHeader ? "border-b border-[#1e3045]" : "border-b border-[#141f2e]/50"} mb-0`}>
          {cells.map((c, ci) => (
            <div key={ci} className={`flex-1 px-3 py-2 text-sm ${isHeader ? "text-[#d4a843] font-semibold" : "text-[#7a94ad]"}`}
              dangerouslySetInnerHTML={{ __html: parseInline(c) }} />
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
      els.push(<h2 key={`h2-${idx}`} className="text-2xl font-extrabold text-white mt-8 mb-4 bg-gradient-to-r from-[#f0c96622] to-transparent px-4 py-2.5 rounded-xl border-l-4 border-[#d4a843]" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(3)) }} />);
    else if (tr.startsWith("### "))
      els.push(<h3 key={`h3-${idx}`} className="text-lg font-bold text-[#d4a843] mt-6 mb-2 pb-1 border-b border-[#141f2e]" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(4)) }} />);
    else if (tr.startsWith("#### "))
      els.push(<h4 key={`h4-${idx}`} className="text-base font-semibold text-[#4a9eff] mt-4 mb-1" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(5)) }} />);
    else if (tr.startsWith("---") || tr.startsWith("___"))
      els.push(<hr key={`hr-${idx}`} className="border-[#141f2e] my-4" />);
    else if (tr.startsWith("> "))
      els.push(<blockquote key={`bq-${idx}`} className="border-l-4 border-[#d4a843]/50 bg-[#0c1520] px-4 py-2 rounded-r-lg my-3 text-[#7a94ad] italic text-sm" dangerouslySetInnerHTML={{ __html: parseInline(tr.slice(2)) }} />);
    else
      els.push(<p key={`p-${idx}`} className="text-[#8faabb] leading-relaxed mb-2 text-sm" dangerouslySetInnerHTML={{ __html: parseInline(tr) }} />);
  });

  flushLists();
  return <div className="space-y-0.5 font-sans">{els}</div>;
}

// ── Skeleton Loader ────────────────────────────────────────────────────────────
function SkeletonLoader() {
  return (
    <div className="animate-pulse space-y-5 pt-4 text-left">
      <div className="h-8 bg-[#141f2e] rounded-lg w-2/3" />
      <div className="space-y-2">
        {[100, 85, 90, 70, 95].map((w, i) => (
          <div key={i} style={{ width: `${w}%` }} className="h-3.5 bg-[#141f2e] rounded" />
        ))}
      </div>
      <div className="h-7 bg-[#141f2e] rounded-lg w-1/2 mt-4" />
      <div className="space-y-2">
        {[80, 95, 75].map((w, i) => (
          <div key={i} style={{ width: `${w}%` }} className="h-3.5 bg-[#141f2e] rounded" />
        ))}
      </div>
    </div>
  );
}

// ── Policy Modal ───────────────────────────────────────────────────────────────
function PolicyModal({ type, onClose }) {
  const isPrivacy = type === "privacy";

  const privacyContent = `# Privacy Policy
*Effective Date: January 1, 2025 | Last Updated: 2025*

## 1. Introduction
BideshPro ("we", "our", "the service") is an AI-powered scholarship information platform for Bangladeshi students. This Privacy Policy explains what data we collect, how we use it, and your rights.

By using BideshPro, you agree to this Privacy Policy.

## 2. What Data We Collect
When you use BideshPro, the following data is **automatically collected**:

- **IP Address** — to prevent abuse, enforce rate limits, and for analytics
- **City, Region, Country** — geographic location derived from your IP address
- **ISP / Organization name** — your internet service provider
- **Approximate Coordinates (Lat/Lon)** — from IP geolocation (not GPS)
- **Postal Code & Timezone** — from IP geolocation service
- **Search queries** — what you search (country + level + background combinations)
- **Anonymous session ID** — via Firebase Anonymous Authentication (no account needed)
- **Usage analytics** — which countries/scholarships are most searched

We do **NOT** collect: your name, email, phone number, or any personally identifiable information you don't explicitly provide.

## 3. How We Use This Data
- **Abuse prevention** — rate limiting and blocking malicious requests
- **Service analytics** — understanding which scholarships Bangladeshi students need most
- **Service improvement** — improving AI prompt quality based on real usage patterns
- **Internal monitoring** — logs stored in our secure monitoring systems

## 4. Third-Party Services
BideshPro uses these third-party services, each governed by their own privacy policies:

- **Google Gemini AI** (ai.google.dev) — processes your search queries to generate responses
- **Google Search** — Gemini uses real-time Google Search to find scholarship information
- **ipapi.co** — IP geolocation service that provides city/country/ISP data
- **Firebase (Google)** — anonymous authentication and usage analytics storage
- **Vercel** — cloud hosting provider for the application

## 5. Data Retention
- Search logs and IP data: retained for up to **90 days**, then permanently deleted
- Anonymous Firebase session data: retained for up to **1 year**
- No personal accounts or profiles are ever created

## 6. Data Security
We implement industry-standard security measures including HTTPS encryption, API key protection, and rate limiting. However, no system is 100% secure.

## 7. Your Rights
You have the right to:
- Use the service without creating any account
- Know what data is collected (this policy)
- Stop using the service at any time

## 8. No Sale of Data
We do **not** sell, rent, trade, or share your personal data with any third party for marketing purposes.

## 9. Children's Privacy
BideshPro is not directed at children under 13. We do not knowingly collect data from children under 13.

## 10. Changes to This Policy
We may update this Privacy Policy periodically. Continued use of the service after changes implies acceptance of the updated policy.

## 11. Contact
For privacy concerns, contact the developer:
- LinkedIn: [Rahat Ahmed](https://www.linkedin.com/in/RahatAhmedX)
- Website: bidesh.pro.bd`;

  const termsContent = `# Terms & Conditions
*Effective Date: January 1, 2025 | Last Updated: 2025*

## 1. Acceptance of Terms
By accessing or using BideshPro ("the Service"), you agree to be bound by these Terms & Conditions. If you do not agree, please discontinue use immediately.

## 2. Description of Service
BideshPro is an AI-powered scholarship information tool for Bangladeshi students seeking international study opportunities. The service uses Google Gemini AI with real-time web search to provide study abroad information including scholarships, living costs, and program details.

## 3. ⚠️ Accuracy Disclaimer (IMPORTANT)
**All scholarship information provided by BideshPro is AI-generated from web searches and may be:**

- **Outdated** — scholarship deadlines, amounts, and requirements change every academic year
- **Incomplete** — not all available scholarships may be listed for any given country
- **Inaccurate** — AI can misinterpret source material or hallucinate information

> **Always verify all information directly from official scholarship websites and embassies before making any application decisions.**

BideshPro is a **research tool** — not an official scholarship portal.

## 4. No Professional Advice
BideshPro does not provide:
- Official legal or immigration advice
- Guaranteed or verified scholarship application guidance
- Professional financial planning advice
- Official university admission counseling

All content is for **informational and research purposes only**.

## 5. Limitation of Liability
To the maximum extent permitted by law, BideshPro and its developer(s) shall not be liable for:

- Any decisions made based on AI-generated content
- Missed scholarship application deadlines
- Rejected visa or scholarship applications
- Financial losses resulting from decisions based on this service
- Service downtime or unavailability

## 6. Acceptable Use
You agree **NOT** to:
- Use automated scripts, bots, or scrapers to abuse the service
- Attempt to reverse-engineer, exploit, or attack the API
- Use the service for any illegal or harmful purpose
- Circumvent rate limiting measures
- Share access credentials or API endpoints

## 7. Service Availability
BideshPro is provided **"as is"** without warranty of any kind. We do not guarantee:
- 100% uptime or availability
- Accuracy of any AI-generated response
- Availability of any specific scholarship or program

## 8. Intellectual Property
- All BideshPro branding, design, and code are owned by the developer
- AI-generated content is provided for personal, non-commercial, informational use
- You may not reproduce, redistribute, or commercialize content from BideshPro

## 9. Privacy
Your use of BideshPro is also governed by our Privacy Policy. By using the service, you consent to the data practices described therein.

## 10. Changes to Terms
We reserve the right to modify these Terms at any time. Continued use of the service after changes constitutes acceptance of the new Terms.

## 11. Governing Law
These Terms shall be governed by and construed in accordance with the laws of Bangladesh.

## 12. Contact
- LinkedIn: [Rahat Ahmed](https://www.linkedin.com/in/RahatAhmedX)
- Website: bidesh.pro.bd`;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="bg-[#070b12] border border-[#1e3045] rounded-2xl w-full max-w-2xl max-h-[88vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#141f2e] flex-shrink-0">
          <h2 className="text-lg font-bold text-white font-serif">
            {isPrivacy ? "🔒 Privacy Policy" : "📋 Terms & Conditions"}
          </h2>
          <button onClick={onClose} className="text-[#7a94ad] hover:text-white text-2xl leading-none transition-colors w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#141f2e]">✕</button>
        </div>
        <div className="overflow-y-auto px-6 py-5 flex-1 text-sm">
          <MarkdownRenderer text={isPrivacy ? privacyContent : termsContent} />
        </div>
        <div className="px-6 py-4 border-t border-[#141f2e] flex-shrink-0">
          <button
            onClick={onClose}
            className="w-full bg-[#d4a843] hover:bg-[#e5b954] text-black font-bold py-2.5 rounded-xl transition-colors"
          >
            I Understand — Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Consent Banner ─────────────────────────────────────────────────────────────
function ConsentBanner({ onAccept, onViewPolicy }) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-[100] bg-[#070b12] border-t border-[#1e3045] shadow-2xl p-4">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex-1 text-sm text-[#7a94ad] leading-relaxed">
          🍪 BideshPro collects anonymous usage data (IP, location, search queries) for analytics and service improvement.{" "}
          <button onClick={onViewPolicy} className="text-[#4a9eff] underline hover:text-[#2ecc8a] transition-colors">
            Privacy Policy
          </button>
        </div>
        <button
          onClick={onAccept}
          className="flex-shrink-0 bg-[#d4a843] hover:bg-[#e5b954] text-black font-bold px-6 py-2 rounded-xl text-sm transition-colors"
        >
          Accept & Continue
        </button>
      </div>
    </div>
  );
}

// ── Countries ──────────────────────────────────────────────────────────────────
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

// ── Main App ───────────────────────────────────────────────────────────────────
function MainApp() {
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

  // ── Persist result in localStorage (survives viewport change + refresh) ────
  const PERSIST_KEY = "bideshpro_last_result";

  // ── Session restore ────────────────────────────────────────────────────────
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
      // Restore last result from localStorage
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

  // ── Session save (view/filters/language) ──────────────────────────────────
  useEffect(() => {
    try {
      sessionStorage.setItem(
        "bideshpro_state",
        JSON.stringify({ view, selectedCountry, level, background, language })
      );
    } catch (_) {}
  }, [view, selectedCountry, level, background, language]);

  // ── Persist results to localStorage ───────────────────────────────────────
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

  // ── Auto-scroll to result ──────────────────────────────────────────────────
  useEffect(() => {
    if (resultText && resultRef.current)
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [resultText]);

  // ── Helpers ────────────────────────────────────────────────────────────────
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


  // ✅ FIX: No Broken Links + Strict Rules (Safe Length)
  const buildPrompt = useCallback((country, lvl, bg) => {
    const lvlText = lvl === "all" ? "All Levels (Bachelor, Master's & PhD)" : lvl.charAt(0).toUpperCase() + lvl.slice(1);
    const bgText  = bg  === "all" ? "All Backgrounds (Science, Arts, Commerce)" : bg.charAt(0).toUpperCase() + bg.slice(1);

    return `You are a highly experienced international scholarship consultant for Bangladeshi students.

CRITICAL DIRECTIVE: USE GOOGLE SEARCH to find current, authentic data.

🎯 Country: ${country.name}
🎓 Degree: ${lvlText}
📚 Background: ${bgText}
🌐 Language: ${language}

⚠️ STRICT RULES (DO NOT VIOLATE):
1. EXACT MATCH: Ensure universities ACTUALLY offer "${bgText}" for "${lvlText}". Do not suggest purely Tech/Engg universities if background is Arts/Commerce.
2. LATEST QUOTAS: Search for "Bangladeshi student quota ${country.name} scholarship recent updates". State if there is a specific quota (e.g. 500) or if it's globally open.
3. CURRENT DEADLINES: Give exact dates for the CURRENT YEAR. If unpublished, use last year's dates and note "(Based on last year's cycle)". Do not write "Varies".
4. NO BROKEN LINKS (CRITICAL): Do NOT guess or hallucinate deep URLs. If you cannot verify the exact application portal link via search, provide the MAIN homepage of the university (e.g., https://www.harvard.edu) instead of making up a broken link.

═══════════════════════════════════
📋 FORMAT (Use these exact headers):
═══════════════════════════════════

## 🎓 Scholarships in ${country.name}
(List 2-3 highly relevant scholarships)

### 🏆 [Official Scholarship Name]
- 💰 **Coverage:** (Tuition, stipend in local currency & USD, etc.)
- 📅 **Deadline:** (Exact dates)
- 🗓 **Intake:** (Semester/month)
- ⏳ **Duration:** (Years)
- ✅ **Eligibility:** Age limit, GPA (out of 5.0) / CGPA (out of 4.0), accepted backgrounds.
- 📄 **Required Documents:** (List)
- 🗣 **Language:** (IELTS/TOEFL requirements)
- 🇧🇩 **Bangladesh Quota:** (Exact seats or "Global")
- 🔗 **Official Site:** [Name](REAL_URL_ONLY)
- 📝 **Apply Here:** [Portal](REAL_URL_ONLY)

---

## 📚 Available Programs (${bgText} at ${lvlText})
(Top universities offering ${bgText})

## 🗣 Language of Instruction
(English vs local language)

## 💼 Part-Time Jobs
- Legal hours/week: ...
- Avg hourly wage: ... (Local + BDT)
- Monthly earning potential: ...

## 🏠 Monthly Living Expenses Breakdown
| Category | Cost (Local) | ≈ BDT |
|----------|--------------|-------|
| Accommodation | ... | ... |
| Food | ... | ... |
| Transport | ... | ... |
| Total | ... | ... |

## 📊 Financial Feasibility
(Scholarship + part-time − living costs = ?)

## ✅ Pros of Studying in ${country.name}
## ⚠️ Cons & Challenges
## 🔗 All Important Links
| Resource | Link (REAL_URL_ONLY) |
|----------|----------------------|
| Embassy | ... |
| Visa Portal | ... |`;
  }, [language]);

  // ── Fetch scholarship ──────────────────────────────────────────────────────
  const fetchScholarship = useCallback(async (country, lvl, bg) => {
    if (isOffline) return setError("You are offline. Please check your internet connection.");
    setLoading(true); setError(null); setResultText(null); setCopied(false); setView(VIEWS.RESULT);

    const cacheKey = `C_${country.name}_L_${lvl}_B_${bg}_${language}`;
    const cached = CacheService.get(cacheKey);
    if (cached) { setResultText(cached); setLoading(false); return; }

    try {
      const text = await ApiService.fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: buildPrompt(country, lvl, bg), locationData: userInfo, searchQuery: cacheKey }),
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
    } finally { setLoading(false); }
  }, [userInfo, updateAnalytics, isOffline, language, buildPrompt]);

  // ── Global Ask ─────────────────────────────────────────────────────────────
  const handleGlobalAsk = useCallback(async (qOverride) => {
    const q = typeof qOverride === "string" ? qOverride : globalQ;
    if (!q.trim() || isOffline) return;

    setLoading(true); setGlobalResult(null); setView(VIEWS.SEARCH); setCopied(false);

    const cacheKey = `Global_${q.trim()}_${language}`;
    const cached = CacheService.get(cacheKey);
    if (cached) { setGlobalResult(cached); setLoading(false); saveHistory(q); return; }

    const prompt = `You are an expert international scholarship and study abroad consultant for Bangladeshi students.

Answer comprehensively using Google Search to ensure verified, current information:

"${q}"

⚠️ Rules:
- Write entirely in ${language}
- ALWAYS use Google Search to verify facts.
- Include REAL, working URLs ONLY. Do not hallucinate links. If unsure, provide the main website homepage.
- Include Bangladesh-specific quota/seat info where available.
- Mention SSC/HSC GPA (out of 5.0) and CGPA (out of 4.0).
- Format with clear headers and bullet points.
- Include official deadlines (current year).

Format response with emojis and clear sections. End with a "🔗 Useful Links" section (REAL URLs ONLY).`;

    try {
      const text = await ApiService.fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, locationData: userInfo, searchQuery: cacheKey }),
      });
      CacheService.set(cacheKey, text);
      setGlobalResult(text);
      saveHistory(q);
    } catch (err) { setGlobalResult("❌ Error: " + err.message); }
    finally { setLoading(false); }
  }, [globalQ, userInfo, isOffline, language, saveHistory]);

  const getTrend = useCallback((name) => {
    const idx = analyticsData.findIndex((a) => a.id === name);
    if (idx === 0) return "🔥";
    if (idx === 1) return "⭐";
    if (idx === 2) return "📈";
    return null;
  }, [analyticsData]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#03050a] text-[#dde6f0] font-sans selection:bg-[#d4a843] selection:text-black pb-20">
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
            className="flex items-center gap-2 sm:gap-3 cursor-pointer flex-shrink-0"
            onClick={() => { setView(VIEWS.COUNTRIES); setSelectedCountry(null); }}
          >
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-[#d4a843] to-[#8a6b24] flex items-center justify-center text-lg sm:text-xl shadow-lg flex-shrink-0">🎓</div>
            <div className="flex flex-col">
              <h1 className="text-lg sm:text-xl font-bold leading-tight font-serif tracking-wide">
                <span className="text-white">Bidesh</span><span className="text-[#d4a843]">Pro</span>
              </h1>
              <p className="text-[8px] sm:text-[10px] text-[#7a94ad] tracking-widest font-semibold uppercase mt-0.5 flex items-center">
                <span className="bg-[#d4a843] text-black px-1 py-0.5 rounded text-[7px] sm:text-[8px] font-bold mr-1 sm:mr-1.5">BETA</span>
                Developed by{" "}
                <a
                  href="https://www.linkedin.com/in/RahatAhmedX"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#4a9eff] hover:underline ml-0.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  Rahat
                </a>
              </p>
            </div>
          </div>

          {/* Nav */}
          <div className="flex items-center gap-1 sm:gap-2">
            <div className="flex bg-[#141f2e] rounded-lg p-0.5 border border-[#1e3045]">
              {["English", "Bengali"].map((lang) => (
                <button
                  key={lang}
                  onClick={() => setLanguage(lang)}
                  className={`px-2 py-1 sm:px-2.5 text-[10px] sm:text-[11px] font-bold rounded-md transition-all ${
                    language === lang ? "bg-[#d4a843] text-black" : "text-[#7a94ad] hover:text-white"
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
                className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
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

        {/* ── COUNTRIES ── */}
        {view === VIEWS.COUNTRIES && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-10">
              <h2 className="text-3xl md:text-5xl font-serif font-bold text-white mb-3 leading-tight">
                Study Abroad Scholarships<br />
                <span className="text-[#d4a843]">for Bangladeshi Students</span>
              </h2>
            </div>

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

            <div className="bg-[#070b12] border border-[#141f2e] rounded-2xl p-5 mb-8 flex flex-col md:flex-row gap-5">
              <div className="flex-1">
                <label className="block text-xs font-bold text-[#3d5269] uppercase tracking-wider mb-2">Search Country</label>
                <input
                  type="text"
                  placeholder="e.g. Germany, Japan..."
                  value={countrySearch}
                  onChange={(e) => setCountrySearch(e.target.value)}
                  className="w-full bg-[#0b1119] border border-[#141f2e] focus:border-[#d4a843] rounded-xl px-4 py-3 text-white outline-none transition-all placeholder-[#3d5269] text-sm"
                />
              </div>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#3d5269] uppercase tracking-wider mb-2">Degree Level</label>
                  <div className="flex flex-wrap gap-2">
                    {["all","bachelor","masters","phd"].map((l) => (
                      <button key={l} onClick={() => setLevel(l)}
                        className={`px-4 py-1.5 rounded-full text-xs font-semibold capitalize transition-all ${level === l ? "bg-[#d4a843] text-black" : "bg-[#141f2e]/60 text-[#7a94ad] hover:bg-[#141f2e]"}`}>
                        {l === "all" ? "All Levels" : l === "phd" ? "PhD" : l.charAt(0).toUpperCase() + l.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#3d5269] uppercase tracking-wider mb-2">Background</label>
                  <div className="flex flex-wrap gap-2">
                    {["all","science","arts","commerce"].map((bg) => (
                      <button key={bg} onClick={() => setBackground(bg)}
                        className={`px-4 py-1.5 rounded-full text-xs font-semibold capitalize transition-all ${background === bg ? "bg-[#d4a843] text-black" : "bg-[#141f2e]/60 text-[#7a94ad] hover:bg-[#141f2e]"}`}>
                        {bg === "all" ? "All" : bg.charAt(0).toUpperCase() + bg.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {filteredCountries.map((c) => {
                const trend = getTrend(c.name);
                return (
                  <div
                    key={c.name}
                    tabIndex={0} role="button"
                    onClick={() => { setSelectedCountry(c); fetchScholarship(c, level, background); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { setSelectedCountry(c); fetchScholarship(c, level, background); }}}
                    className="relative bg-[#0b1119] border border-[#141f2e] hover:border-[#d4a843]/60 rounded-2xl p-4 cursor-pointer transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-[#d4a843]/5 focus:outline-none focus:border-[#d4a843] group"
                  >
                    {trend && <span className="absolute top-2 right-2 text-xs">{trend}</span>}
                    <div className="text-3xl mb-2 group-hover:scale-110 transition-transform origin-left">{c.flag}</div>
                    <h3 className="font-bold text-white text-sm mb-1 leading-tight">{c.name}</h3>
                    <p className="text-[10px] text-[#3d5269] leading-tight line-clamp-2">{c.hint}</p>
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
              <button onClick={() => setView(VIEWS.COUNTRIES)} className="flex items-center gap-1 text-[#7a94ad] hover:text-white px-3 py-1.5 rounded-lg hover:bg-[#141f2e] transition-all text-sm">← Back</button>
              {selectedCountry && (
                <div className="flex items-center gap-2">
                  <span className="text-3xl">{selectedCountry.flag}</span>
                  <span className="font-bold text-white text-lg font-serif">{selectedCountry.name}</span>
                </div>
              )}
              <div className="ml-auto flex gap-1.5 flex-wrap">
                {["all","bachelor","masters","phd"].map((l) => (
                  <button key={l}
                    onClick={() => { setLevel(l); fetchScholarship(selectedCountry, l, background); }}
                    className={`px-3 py-1 rounded-full text-xs font-semibold capitalize transition-all ${level === l ? "bg-[#d4a843] text-black" : "bg-[#141f2e] text-[#7a94ad] hover:text-white"}`}>
                    {l === "all" ? "All" : l === "phd" ? "PhD" : l.charAt(0).toUpperCase() + l.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div ref={resultRef} className="bg-[#070b12] border border-[#141f2e] rounded-3xl p-6 md:p-10 shadow-2xl">
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
                    <button onClick={() => handleCopy(resultText)} className="px-4 py-2 bg-[#141f2e] hover:bg-[#1e3045] text-white rounded-xl text-sm font-medium transition-all">
                      {copied ? "✅ Copied!" : "📋 Copy"}
                    </button>
                  </div>
                )}
              </div>

              {loading ? (
                <div className="text-center py-10">
                  <div className="inline-block text-5xl animate-spin mb-5">🌍</div>
                  <h3 className="text-[#d4a843] font-bold text-lg mb-2">AI is analyzing verified data...</h3>
                  <p className="text-[#7a94ad] text-sm mb-6 max-w-[320px] mx-auto leading-relaxed">
                    Gathering scholarships, part-time jobs, and living costs for {level === 'all' ? 'all levels' : `${level} level`} in {selectedCountry?.name}.
                  </p>
                  <SkeletonLoader />
                </div>
              ) : error ? (
                <div className="bg-[#1a0a0a] border border-[#e05555]/30 rounded-2xl p-6">
                  <h4 className="font-bold text-[#e05555] mb-2">⚠️ Error</h4>
                  <p className="text-sm text-[#e05555]/80 mb-4">{error}</p>
                  <button onClick={() => fetchScholarship(selectedCountry, level, background)} className="px-5 py-2 bg-[#e05555]/20 hover:bg-[#e05555]/30 rounded-xl text-sm text-[#e05555] transition-all">Retry</button>
                </div>
              ) : resultText ? (
                <>
                  <MarkdownRenderer text={resultText} />
                  <div className="mt-8 p-4 bg-[#d4a843]/8 border border-[#d4a843]/25 rounded-xl text-xs text-[#7a94ad]">
                    ⚠️ Always verify deadlines and requirements from official scholarship websites before applying.
                  </div>
                </>
              ) : null}
            </div>
          </div>
        )}

        {/* ── SEARCH ── */}
        {view === VIEWS.SEARCH && (
          <div className="animate-in fade-in max-w-3xl mx-auto">
            <h2 className="text-3xl font-serif font-bold text-white mb-2">Ask AI Counselor</h2>
            <p className="text-[#7a94ad] mb-6 text-sm">স্কলারশিপ সম্পর্কে যেকোনো প্রশ্ন করুন — AI Google Search করে verified উত্তর দেবে।</p>

            {history.length > 0 && (
              <div className="flex gap-2 flex-wrap mb-4 items-center">
                <span className="text-xs text-[#3d5269] font-semibold">Recent:</span>
                {history.map((h, i) => (
                  <button key={i} onClick={() => { setGlobalQ(h); handleGlobalAsk(h); }}
                    className="text-xs bg-[#141f2e] hover:bg-[#1e3045] text-[#7a94ad] hover:text-white px-3 py-1.5 rounded-full border border-[#1e3045] truncate max-w-[180px] transition-colors">
                    {h}
                  </button>
                ))}
              </div>
            )}

            <div className="relative mb-6">
              <textarea
                value={globalQ}
                onChange={(e) => setGlobalQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleGlobalAsk(); }}}
                placeholder="Ask anything about study abroad..."
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

            {loading ? (
              <div className="bg-[#070b12] rounded-2xl p-8 border border-[#141f2e]"><SkeletonLoader /></div>
            ) : globalResult ? (
              <div className="bg-[#070b12] border border-[#141f2e] rounded-2xl p-6 md:p-8 relative shadow-xl">
                {!globalResult.startsWith("❌") && (
                  <button onClick={() => handleCopy(globalResult)} className="absolute top-4 right-4 px-3 py-1 bg-[#141f2e] text-[#7a94ad] hover:text-white rounded-lg text-xs transition-colors">
                    {copied ? "✅" : "📋 Copy"}
                  </button>
                )}
                {globalResult.startsWith("❌") ? (
                  <p className="text-[#e05555] text-sm">{globalResult}</p>
                ) : (
                  <MarkdownRenderer text={globalResult} />
                )}
              </div>
            ) : null}
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-[#141f2e] mt-12 py-6 px-4">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-3 text-xs text-[#3d5269]">
          <div className="flex items-center gap-2">
            <span className="text-[#d4a843] font-bold">BideshPro</span>
            <span>© 2025</span>
            <span>·</span>
            <a href="https://www.linkedin.com/in/RahatAhmedX" target="_blank" rel="noopener noreferrer" className="hover:text-[#4a9eff] transition-colors">
              by Rahat Ahmed
            </a>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => setPolicyModal("privacy")} className="hover:text-[#4a9eff] transition-colors underline underline-offset-2">Privacy Policy</button>
            <button onClick={() => setPolicyModal("terms")} className="hover:text-[#4a9eff] transition-colors underline underline-offset-2">Terms & Conditions</button>
          </div>
          <div className="hidden sm:block text-[#1e3045] text-[10px]">AI data may be inaccurate — always verify before applying</div>
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