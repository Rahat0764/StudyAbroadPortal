import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, updateDoc, increment } from "firebase/firestore";

// ── Constants & Config ──────────────────────────────────────────────────
const VIEWS = { COUNTRIES: "countries", SEARCH: "search", RESULT: "result" };
const CACHE_LIMIT = 20;

class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError(error) { return { hasError: true }; }
  componentDidCatch(error, errorInfo) { console.error("Global Error:", error, errorInfo); }
  render() {
    if (this.state.hasError) return <div className="p-10 text-center text-red-500 bg-[#070b12] min-h-screen"><h2>Something went wrong. Please refresh the page.</h2></div>;
    return this.props.children;
  }
}

// ── Firebase Setup ────────────────────────────────────────────────────────
let app, auth, db, appId;
try {
  const firebaseConfig = typeof __firebase_config !== "undefined" ? JSON.parse(__firebase_config) : null;
  appId = typeof __app_id !== "undefined" ? String(__app_id) : "default-app-id";
  if (firebaseConfig && appId) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  }
} catch (error) { console.warn("Firebase config issue, analytics disabled."); }

// ── Custom Hooks ──────────────────────────────────────────────────────────
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

function useOfflineStatus() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);
  return isOffline;
}

// ── Utility Services ──────────────────────────────────────────────────────
const CacheService = {
  cache: new Map(),
  set(key, value) {
    if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key.toLowerCase().trim(), value);
  },
  get(key) { return this.cache.get(key.toLowerCase().trim()); },
};

const ApiService = {
  async fetchWithRetry(url, options, retries = 2) {
    for (let i = 0; i < retries; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 35000);
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Server Error");
        return data.text;
      } catch (err) {
        if (err.name === "AbortError") throw new Error("Request timed out");
        if (i === retries - 1) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  },
};

async function fetchUserIPDetails() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://ipapi.co/json/", { signal: controller.signal });
    clearTimeout(t);
    const data = await res.json();
    return { ip: data.ip || "Unknown", city: data.city, country: data.country_name, org: data.org };
  } catch (error) { return { ip: "Unknown", city: "Unknown", country: "Unknown", org: "Unknown" }; }
}

const copyToClipboardSafely = async (text) => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      textArea.remove();
    }
    return true;
  } catch (err) { return false; }
};

function MarkdownRenderer({ text }) {
  if (!text) return null;
  const escapeHTML = (str) => str.replace(/[&<>'"]/g, (tag) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[tag] || tag));
  const sanitizeUrl = (url) => {
    const clean = url.trim().replace(/['"]/g, "");
    if (clean.toLowerCase().startsWith("javascript:") || clean.toLowerCase().startsWith("data:")) return "#";
    return clean;
  };

  const parseInline = (str) => {
    let safeHtml = escapeHTML(str);
    safeHtml = safeHtml.replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>');
    safeHtml = safeHtml.replace(/\*(.*?)\*/g, '<em class="text-[#22c7b8]">$1</em>');
    safeHtml = safeHtml.replace(/`(.*?)`/g, '<code class="bg-[#1a2a3a] text-[#4a9eff] px-1.5 py-0.5 rounded text-sm">$1</code>');
    safeHtml = safeHtml.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, title, url) => {
      return `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer" class="text-[#4a9eff] hover:underline hover:text-[#2ecc8a] font-medium break-all">${title}</a>`;
    });
    return safeHtml;
  };

  const lines = text.split("\n");
  const elements = [];
  let currentList = [];
  let listType = null;

  const pushList = () => {
    if (currentList.length > 0) {
      if (listType === "ul") elements.push(<ul key={`ul-${elements.length}`} className="list-disc list-inside mb-4 space-y-1 text-[#7a94ad]">{currentList}</ul>);
      else elements.push(<ol key={`ol-${elements.length}`} className="list-decimal list-inside mb-4 space-y-1 text-[#7a94ad]">{currentList}</ol>);
      currentList = []; listType = null;
    }
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const isUl = trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("• ");
    const isOl = /^\d+\.\s/.test(trimmed);

    if (isUl || isOl) {
      if (!listType) listType = isUl ? "ul" : "ol";
      const content = trimmed.replace(/^[-*•]\s|^\d+\.\s/, "");
      currentList.push(<li key={`li-${index}`} className="pl-2 leading-relaxed" dangerouslySetInnerHTML={{ __html: parseInline(content) }} />);
      return;
    } else { pushList(); }

    if (!trimmed) elements.push(<div key={`br-${index}`} className="h-3" />);
    else if (trimmed.startsWith("### ")) elements.push(<h3 key={`h3-${index}`} className="text-xl font-bold text-[#d4a843] mt-6 mb-3 border-b border-[#141f2e] pb-2">{parseInline(trimmed.slice(4))}</h3>);
    else if (trimmed.startsWith("## ")) elements.push(<h2 key={`h2-${index}`} className="text-2xl font-extrabold text-white mt-8 mb-4 bg-gradient-to-r from-[#f0c96622] to-transparent p-3 rounded-lg border-l-4 border-[#d4a843]">{parseInline(trimmed.slice(3))}</h2>);
    else if (trimmed.startsWith("# ")) elements.push(<h1 key={`h1-${index}`} className="text-3xl font-extrabold text-[#d4a843] mt-4 mb-6">{parseInline(trimmed.slice(2))}</h1>);
    else elements.push(<p key={`p-${index}`} className="text-[#7a94ad] leading-relaxed mb-3" dangerouslySetInnerHTML={{ __html: parseInline(trimmed) }} />);
  });
  pushList();
  return <div className="markdown-body font-sans">{elements}</div>;
}

// ── Components ────────────────────────────────────────────────────────────
const COUNTRIES = [
  { name: "United States", flag: "🇺🇸", hint: "Fulbright, Assistantships" },
  { name: "United Kingdom", flag: "🇬🇧", hint: "Chevening, Commonwealth" },
  { name: "Canada", flag: "🇨🇦", hint: "Vanier, McCall MacBain" },
  { name: "Australia", flag: "🇦🇺", hint: "Australia Awards, RTP" },
  { name: "Germany", flag: "🇩🇪", hint: "DAAD, Free Tuition" },
  { name: "Italy", flag: "🇮🇹", hint: "DSU, Invest Your Talent" },
  { name: "Ireland", flag: "🇮🇪", hint: "GOI-IES, Univ. Specific" },
  { name: "Austria", flag: "🇦🇹", hint: "OeAD, Ernst Mach" },
  { name: "Sweden", flag: "🇸🇪", hint: "SI Scholarship" },
  { name: "Saudi Arabia", flag: "🇸🇦", hint: "King Abdullah, IsDB" },
  { name: "South Korea", flag: "🇰🇷", hint: "GKS/KGSP, POSTECH" },
  { name: "China", flag: "🇨🇳", hint: "CSC, Provincial" },
  { name: "Japan", flag: "🇯🇵", hint: "MEXT, JASSO" },
  { name: "Hungary", flag: "🇭🇺", hint: "Stipendium Hungaricum" },
];

function SkeletonLoader() {
  return (
    <div className="animate-pulse space-y-6 pt-4">
      <div className="h-8 bg-[#141f2e] rounded w-1/3"></div>
      <div className="space-y-3"><div className="h-4 bg-[#141f2e] rounded w-full"></div><div className="h-4 bg-[#141f2e] rounded w-5/6"></div><div className="h-4 bg-[#141f2e] rounded w-4/6"></div></div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────
function MainApp() {
  const [view, setView] = useState(VIEWS.COUNTRIES);
  const [language, setLanguage] = useState("English"); // AI Language State
  const [userAuth, setUserAuth] = useState(null);
  const [userInfo, setUserInfo] = useState(null);
  const isOffline = useOfflineStatus();

  const [selectedCountry, setSelectedCountry] = useState(null);
  const [level, setLevel] = useState("all");
  const [background, setBackground] = useState("all");
  const [countrySearchQuery, setCountrySearchQuery] = useState("");
  const debouncedCountryQuery = useDebounce(countrySearchQuery, 300);

  const [resultText, setResultText] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const [globalAskQuery, setGlobalAskQuery] = useState("");
  const [globalAskResult, setGlobalAskResult] = useState(null);
  const [searchHistory, setSearchHistory] = useState([]);
  const [analyticsData, setAnalyticsData] = useState([]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("scholarpath_history");
      if (saved) setSearchHistory(JSON.parse(saved));
    } catch (e) { console.warn("Failed to load history"); }
  }, []);

  const saveToHistory = (query) => {
    setSearchHistory((prev) => {
      const updated = [query, ...prev.filter((q) => q !== query)].slice(0, 5);
      localStorage.setItem("scholarpath_history", JSON.stringify(updated));
      return updated;
    });
  };

  useEffect(() => {
    if (!auth) return;
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== "undefined" && __initial_auth_token) await signInWithCustomToken(auth, __initial_auth_token);
        else await signInAnonymously(auth);
      } catch (err) { console.warn("Auth warning:", err); }
    };
    initAuth();
    return onAuthStateChanged(auth, setUserAuth);
  }, []);

  useEffect(() => { fetchUserIPDetails().then(setUserInfo); }, []);

  useEffect(() => {
    if (!userAuth || !db || !appId) return;
    const analyticsRef = collection(db, "artifacts", appId, "public", "data", "search_analytics");
    const unsubscribe = onSnapshot(analyticsRef, (snapshot) => {
        const data = [];
        snapshot.forEach((doc) => data.push({ id: doc.id, count: doc.data().count || 0 }));
        data.sort((a, b) => b.count - a.count);
        setAnalyticsData(data);
      }, () => {} );
    return () => unsubscribe();
  }, [userAuth]);

  const updateAnalytics = useCallback(async (countryName) => {
      if (!userAuth || !db || !appId) return;
      try {
        const docRef = doc(db, "artifacts", appId, "public", "data", "search_analytics", countryName);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) await updateDoc(docRef, { count: increment(1) });
        else await setDoc(docRef, { count: 1 });
      } catch (err) { console.warn("Analytics error suppressed"); }
    }, [userAuth]
  );

  const filteredCountries = useMemo(() => {
    const q = debouncedCountryQuery.toLowerCase();
    return COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q));
  }, [debouncedCountryQuery]);

  const handleCopy = useCallback(async (text) => {
    const success = await copyToClipboardSafely(text);
    if (success) { setCopied(true); setTimeout(() => setCopied(false), 2500); }
  }, []);

  const fetchScholarshipDetails = useCallback(async (country, lvl, bg) => {
      if (isOffline) return setError("You are offline. Please check connection.");

      setLoading(true); setError(null); setResultText(null); setCopied(false); setView(VIEWS.RESULT);

      const cacheKey = `C_${country.name}_L_${lvl}_B_${bg}_Lang_${language}`;
      const cachedData = CacheService.get(cacheKey);
      if (cachedData) { setResultText(cachedData); setLoading(false); return; }

      const prompt = `Act as an expert international scholarship and study abroad consultant for Bangladeshi students. 
      Provide comprehensive, verified, and highly practical information about studying in ${country.name}.
      Target Level: ${lvl} | Background: ${bg}

      You MUST include the following specific sections in your response:
      1. Available Scholarships (with official or verified names).
      2. Part-Time Job Opportunities (Availability for international students, average hourly/monthly wage, and legal working hours).
      3. Living Expenses (Provide a realistic monthly breakdown).
      4. Financial Feasibility & Savings (Calculate: Scholarship Amount + Part-time earnings - Living Expenses = Is savings possible?).
      5. Pros and Cons of studying in ${country.name}.

      IMPORTANT RULES:
      - Use Google Search to find exact, accurate, and up-to-date information.
      - The ENTIRE output MUST be strictly in ${language} language.
      - Format nicely using Markdown with proper headings, bullet points, and bold text.`;

      try {
        const text = await ApiService.fetchWithRetry("/api/search", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, locationData: userInfo, searchQuery: cacheKey }),
        });
        CacheService.set(cacheKey, text);
        setResultText(text);
        updateAnalytics(country.name);
      } catch (err) {
        setError(err.message.includes("Unexpected token") ? "⚠️ Backend API not found. Please deploy to Vercel." : err.message);
      } finally { setLoading(false); }
    }, [userInfo, updateAnalytics, isOffline, language]
  );

  const handleGlobalAsk = useCallback(async (queryOverride) => {
      const queryToUse = typeof queryOverride === "string" ? queryOverride : globalAskQuery;
      if (!queryToUse.trim() || isOffline) return;

      setLoading(true); setGlobalAskResult(null); setView(VIEWS.SEARCH); setCopied(false);

      const cacheKey = `Global_${queryToUse.trim()}_Lang_${language}`;
      const cachedData = CacheService.get(cacheKey);
      if (cachedData) {
        setGlobalAskResult(cachedData); setLoading(false); saveToHistory(queryToUse); return;
      }

      const prompt = `Answer the following question about study abroad for Bangladeshi students: "${queryToUse}"
      Use Google Search to find accurate information and verified links.
      IMPORTANT RULE: The ENTIRE output MUST be strictly in ${language} language.`;

      try {
        const text = await ApiService.fetchWithRetry("/api/search", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, locationData: userInfo, searchQuery: cacheKey }),
        });
        CacheService.set(cacheKey, text);
        setGlobalAskResult(text);
        saveToHistory(queryToUse);
      } catch (err) { setGlobalAskResult("Error: " + err.message); } 
      finally { setLoading(false); }
    }, [globalAskQuery, userInfo, isOffline, language]
  );

  return (
    <div className="min-h-screen bg-[#03050a] text-[#dde6f0] font-sans selection:bg-[#d4a843] selection:text-black pb-12">
      {isOffline && <div className="bg-[#e05555] text-white text-center py-1 text-sm font-bold">You are currently offline.</div>}

      <header className="sticky top-0 z-50 bg-[#050810]/90 backdrop-blur-md border-b border-[#141f2e]">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" aria-label="Home" onClick={() => { setView(VIEWS.COUNTRIES); setSelectedCountry(null); }}>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#d4a843] to-[#8a6b24] flex items-center justify-center text-xl shadow-lg">🎓</div>
            <div>
              <h1 className="text-xl font-bold leading-tight font-serif tracking-wide">
                <span className="text-white">Bidesh</span><span className="text-[#d4a843]">Pro</span>
              </h1>
              <p className="text-[10px] text-[#7a94ad] tracking-widest font-semibold uppercase mt-0.5">
                BETA • Developed by <a href="https://www.linkedin.com/in/RahatAhmedX" target="_blank" rel="noopener noreferrer" className="text-[#4a9eff] hover:underline">Rahat</a>
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-2 bg-[#0b1119] p-1.5 rounded-lg border border-[#141f2e]">
            {/* Language Switcher */}
            <div className="flex bg-[#141f2e] rounded-md p-0.5 mr-1 border border-[#1e3045]">
              <button onClick={() => setLanguage('English')} className={`px-2 py-1 text-[10px] font-bold rounded transition-colors ${language === 'English' ? 'bg-[#d4a843] text-black shadow' : 'text-[#7a94ad] hover:text-white'}`}>EN</button>
              <button onClick={() => setLanguage('Bengali')} className={`px-2 py-1 text-[10px] font-bold rounded transition-colors ${language === 'Bengali' ? 'bg-[#d4a843] text-black shadow' : 'text-[#7a94ad] hover:text-white'}`}>BN</button>
            </div>
            
            <button aria-label="View Countries" onClick={() => setView(VIEWS.COUNTRIES)} className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors hidden sm:block ${view === VIEWS.COUNTRIES || view === VIEWS.RESULT ? "bg-[#d4a843] text-black shadow-sm" : "text-[#7a94ad] hover:text-white"}`}>🌍 Countries</button>
            <button aria-label="View Countries Mobile" onClick={() => setView(VIEWS.COUNTRIES)} className={`px-2 py-1.5 rounded-md text-sm font-medium transition-colors sm:hidden ${view === VIEWS.COUNTRIES || view === VIEWS.RESULT ? "bg-[#d4a843] text-black shadow-sm" : "text-[#7a94ad] hover:text-white"}`}>🌍</button>
            
            <button aria-label="Ask AI" onClick={() => setView(VIEWS.SEARCH)} className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors hidden sm:block ${view === VIEWS.SEARCH ? "bg-[#d4a843] text-black shadow-sm" : "text-[#7a94ad] hover:text-white"}`}>🔍 Ask AI</button>
            <button aria-label="Ask AI Mobile" onClick={() => setView(VIEWS.SEARCH)} className={`px-2 py-1.5 rounded-md text-sm font-medium transition-colors sm:hidden ${view === VIEWS.SEARCH ? "bg-[#d4a843] text-black shadow-sm" : "text-[#7a94ad] hover:text-white"}`}>🔍</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {view === VIEWS.COUNTRIES && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="mb-10 flex flex-col md:flex-row gap-8 justify-between items-start">
              <div className="text-left flex-1">
                <h2 className="text-3xl md:text-5xl font-serif font-bold text-white mb-4 leading-tight">
                  Study Abroad Scholarships <br className="hidden md:block" />
                  <span className="text-[#d4a843]">for Bangladeshis</span>
                </h2>
                <p className="text-[#7a94ad] max-w-2xl text-base md:text-lg">
                  AI ইন্টারনেট সার্চ করে পার্টটাইম জব, লিভিং এক্সপেন্স এবং রিয়েল স্কলারশিপের তথ্য বের করবে।
                </p>
              </div>
              {analyticsData.length > 0 && (
                <div className="bg-[#070b12] border border-[#141f2e] rounded-2xl p-4 w-full md:w-64 flex-shrink-0 shadow-lg">
                  <h3 className="text-[#d4a843] font-bold text-sm mb-3">🔥 Trending Searches</h3>
                  <div className="space-y-2">
                    {analyticsData.slice(0, 5).map((item, idx) => (
                      <div key={item.id} className="flex justify-between items-center bg-[#0b1119] p-2 rounded-lg border border-[#141f2e]">
                        <span className="text-xs text-white"><span className="text-[#7a94ad] mr-1">#{idx + 1}</span> {item.id}</span>
                        <span className="text-xs bg-[#141f2e] text-[#4a9eff] px-2 py-0.5 rounded-full font-bold">{item.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-[#070b12] border border-[#141f2e] rounded-2xl p-5 mb-8 flex flex-col md:flex-row gap-6 shadow-lg">
              <div className="flex-1">
                <label htmlFor="countrySearch" className="block text-xs font-bold text-[#3d5269] uppercase mb-2">Search Country</label>
                <input id="countrySearch" type="text" placeholder="e.g. USA, Italy, Sweden..." value={countrySearchQuery} onChange={(e) => setCountrySearchQuery(e.target.value)} className="w-full bg-[#0b1119] border border-[#141f2e] focus:border-[#d4a843] rounded-xl px-4 py-3 text-white outline-none transition-all placeholder-[#3d5269]"/>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-[#3d5269] uppercase mb-2">Degree Level</label>
                  <div className="flex flex-wrap gap-2">
                    {["all", "bachelor", "masters", "phd"].map((l) => (
                      <button key={l} onClick={() => setLevel(l)} className={`px-4 py-2 rounded-full text-xs font-semibold capitalize transition-all ${level === l ? "bg-[#d4a843] text-black" : "bg-[#141f2e]/50 text-[#7a94ad] hover:bg-[#141f2e]"}`}>{l}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#3d5269] uppercase mb-2">Background</label>
                  <div className="flex flex-wrap gap-2">
                    {["all", "science", "arts", "commerce"].map((bg) => (
                      <button key={bg} onClick={() => setBackground(bg)} className={`px-4 py-2 rounded-full text-xs font-semibold capitalize transition-all ${background === bg ? "bg-[#d4a843] text-black" : "bg-[#141f2e]/50 text-[#7a94ad] hover:bg-[#141f2e]"}`}>{bg}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {filteredCountries.length === 0 ? (
              <div className="text-center py-16 bg-[#070b12] rounded-2xl border border-[#141f2e]">
                <span className="text-4xl mb-3 block">🌍</span>
                <h3 className="text-xl text-white font-bold mb-2">দেশ খুঁজে পাওয়া যায়নি</h3>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {filteredCountries.map((c) => (
                  <div key={c.name} tabIndex="0" role="button" aria-label={`Select ${c.name}`} onClick={() => { setSelectedCountry(c); fetchScholarshipDetails(c, level, background); }} onKeyDown={(e) => { if (e.key === "Enter") { setSelectedCountry(c); fetchScholarshipDetails(c, level, background); } }} className="bg-[#0b1119] border border-[#141f2e] hover:border-[#d4a843]/60 rounded-2xl p-4 cursor-pointer transition-all hover:-translate-y-1 hover:shadow-lg focus:outline-none focus:border-[#d4a843] group">
                    <div className="text-4xl mb-3 group-hover:scale-110 transition-transform origin-left">{c.flag}</div>
                    <h3 className="font-bold text-white mb-1">{c.name}</h3>
                    <p className="text-xs text-[#3d5269] line-clamp-2">{c.hint}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {view === VIEWS.RESULT && (
          <div className="animate-in fade-in max-w-4xl mx-auto">
            <button onClick={() => setView(VIEWS.COUNTRIES)} className="flex items-center gap-2 text-[#7a94ad] hover:text-white mb-6 transition-colors px-3 py-1.5 rounded-lg hover:bg-[#141f2e]">
              &larr; Back
            </button>
            <div className="bg-[#070b12] border border-[#141f2e] rounded-3xl p-6 md:p-10 shadow-2xl relative">
              <div className="flex flex-col md:flex-row justify-between gap-6 mb-8 pb-8 border-b border-[#141f2e]">
                <div className="flex items-center gap-4">
                  <span className="text-5xl md:text-6xl">{selectedCountry?.flag}</span>
                  <div>
                    <h2 className="text-3xl md:text-4xl font-serif font-bold text-white mb-1">{selectedCountry?.name}</h2>
                    <p className="text-sm text-[#d4a843] font-medium tracking-wide">VERIFIED REPORT (Lvl: {level}, Bg: {background})</p>
                  </div>
                </div>
                {resultText && !loading && (
                  <button aria-label="Copy to clipboard" onClick={() => handleCopy(resultText)} className="px-4 py-2 bg-[#141f2e] hover:bg-[#1e3045] text-white rounded-lg text-sm font-medium transition-colors">
                    {copied ? "✅ Copied!" : "📋 Copy"}
                  </button>
                )}
              </div>

              {loading ? ( <SkeletonLoader /> ) : error ? (
                <div className="bg-[#e05555]/10 border border-[#e05555]/30 rounded-xl p-6 text-[#e05555]">
                  <h4 className="font-bold mb-1">Error Fetching Data</h4>
                  <p className="text-sm mt-1">{error}</p>
                  <button onClick={() => fetchScholarshipDetails(selectedCountry, level, background)} className="mt-4 px-4 py-2 bg-[#e05555]/20 hover:bg-[#e05555]/30 rounded-lg text-sm">Retry</button>
                </div>
              ) : ( <MarkdownRenderer text={resultText} /> )}
            </div>
          </div>
        )}

        {view === VIEWS.SEARCH && (
          <div className="animate-in fade-in max-w-3xl mx-auto">
            <div className="mb-8">
              <h2 className="text-3xl font-serif font-bold text-white mb-3">Ask AI Counselor</h2>
              <p className="text-[#7a94ad]">স্কলারশিপ নিয়ে যেকোনো প্রশ্ন করুন (গুগল সার্চ সাপোর্টেড)।</p>
            </div>

            {searchHistory.length > 0 && (
              <div className="mb-6 flex gap-2 flex-wrap">
                <span className="text-xs text-[#3d5269] self-center mr-2">Recent:</span>
                {searchHistory.map((h, i) => (
                  <button key={i} onClick={() => { setGlobalAskQuery(h); handleGlobalAsk(h); }} className="text-xs bg-[#141f2e] text-[#7a94ad] hover:text-white px-3 py-1.5 rounded-full transition-colors">
                    {h}
                  </button>
                ))}
              </div>
            )}

            <div className="relative mb-8">
              <textarea aria-label="Ask a question" value={globalAskQuery} onChange={(e) => setGlobalAskQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleGlobalAsk(); } }} placeholder="Ex: Suggest fully funded bachelor scholarships in Europe..." className="w-full bg-[#070b12] border border-[#141f2e] focus:border-[#d4a843] rounded-2xl p-5 pr-24 text-white outline-none resize-none min-h-[120px]" />
              <button onClick={() => handleGlobalAsk()} disabled={loading || !globalAskQuery.trim()} className="absolute bottom-4 right-4 bg-[#d4a843] hover:bg-[#e5b954] text-black font-bold px-6 py-2.5 rounded-xl disabled:opacity-50">
                {loading ? "Thinking..." : "Ask"}
              </button>
            </div>

            {loading ? ( <div className="bg-[#070b12] rounded-2xl p-8 border border-[#141f2e]"><SkeletonLoader /></div> ) : (
              globalAskResult && (
                <div className="bg-[#070b12] border border-[#141f2e] rounded-2xl p-6 md:p-8 relative shadow-xl">
                  {!globalAskResult.startsWith("Error:") && (
                    <button onClick={() => handleCopy(globalAskResult)} className="absolute top-4 right-4 px-3 py-1 bg-[#141f2e] text-[#7a94ad] hover:text-white rounded-md text-xs transition-colors">
                      {copied ? "Copied" : "Copy"}
                    </button>
                  )}
                  {globalAskResult.startsWith("Error:") ? ( <p className="text-[#e05555]">{globalAskResult}</p> ) : ( <MarkdownRenderer text={globalAskResult} /> )}
                </div>
              )
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function AppWrapper() {
  return <ErrorBoundary><MainApp /></ErrorBoundary>;
}