import React, { useState, useEffect } from 'react';
import { Mode, Language, LANGUAGES, VaultDoc, ChatSession, Message } from './types';
import { translations } from './translations';
import ChatWindow from './components/ChatWindow';
import { simulateDigiLockerFetch } from './services/geminiService';
import { GoogleGenAI, Type } from "@google/genai";

const STORAGE_KEY = 'civic_ease_sessions_v3';

// Secure key retrieval helper
const getApiKey = () => (window as any).API_KEY || process.env.API_KEY;

const App: React.FC = () => {
  const [mode, setMode] = useState<Mode>(Mode.IDLE);
  const [language, setLanguage] = useState<Language>('en');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [realTimeUpdates, setRealTimeUpdates] = useState<string[]>([]);
  const [lastUpdatedTime, setLastUpdatedTime] = useState<string>('');
  
  const [vaultDocs, setVaultDocs] = useState<VaultDoc[]>([
    { id: '1', name: 'Aadhaar Card', type: 'AADHAAR', status: 'NOT_FETCHED' },
    { id: '2', name: 'PAN Card', type: 'PAN', status: 'NOT_FETCHED' },
    { id: '3', name: 'Driving License', type: 'DL', status: 'NOT_FETCHED' },
    { id: '4', name: 'Voter ID', type: 'VOTER_ID', status: 'NOT_FETCHED' },
    { id: '5', name: 'Ration Card', type: 'RATION_CARD', status: 'NOT_FETCHED' },
    { id: '6', name: 'Vaccine Cert', type: 'COVID_CERT', status: 'NOT_FETCHED' },
    { id: '7', name: 'Class X Marks', type: 'CLASS_X_MARK', status: 'NOT_FETCHED' }
  ]);
  
  const [isLockerLinked, setIsLockerLinked] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const [fetchingDocId, setFetchingDocId] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(false);
  const [isLangOpen, setIsLangOpen] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({});

  // Determine if we are in an active service chat mode
  const isChatMode = [Mode.FORM_FILLING, Mode.PROBLEM_REPORTING, Mode.SCHEME_FINDER, Mode.OFFICE_LOCATOR].includes(mode);

  const t = (key: string, variables?: Record<string, string>) => {
    let text = translations[language]?.[key] || translations['en']?.[key] || key;
    if (variables) {
      Object.entries(variables).forEach(([k, v]) => {
        text = text.replace(`{${k}}`, v);
      });
    }
    return text;
  };

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const savedActiveId = localStorage.getItem(STORAGE_KEY + '_active');

    if (saved) {
      try {
        const parsedSessions = JSON.parse(saved);
        setSessions(parsedSessions);
        
        if (savedActiveId) {
          const session = parsedSessions.find((s: ChatSession) => s.id === savedActiveId);
          if (session) {
            setActiveSession(session);
            setMode(session.mode);
            setLanguage(session.language);
          }
        }
      } catch (e) {
        console.error("Failed to parse sessions", e);
      }
    }
  }, []);

  useEffect(() => {
    if (activeSession) {
      localStorage.setItem(STORAGE_KEY + '_active', activeSession.id);
    } else {
      localStorage.removeItem(STORAGE_KEY + '_active');
    }
  }, [activeSession]);

  useEffect(() => {
    const fetchLiveNews = async () => {
      setLastUpdatedTime(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
      try {
        const apiKey = getApiKey();
        if (!apiKey) throw new Error("No API Key");

        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `Provide 5 extremely recent (past 24h) Indian government news headlines/alerts. Short (<8 words). Translate to ${LANGUAGES.find(l => l.code === language)?.name}. JSON Array of strings only.`,
          config: {
            tools: [{ googleSearch: {} }],
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          }
        });
        
        const news = JSON.parse(response.text || '[]');
        if (Array.isArray(news) && news.length > 0) {
          setRealTimeUpdates(news);
        }
      } catch (error) {
        setRealTimeUpdates([
          t('tickerItem1'),
          t('tickerItem2'),
          t('tickerItem3')
        ]);
      }
    };
    
    fetchLiveNews();
    const interval = setInterval(fetchLiveNews, 120000); // Refresh every 2 mins
    return () => clearInterval(interval);
  }, [language]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    if (darkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [darkMode]);

  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => setUserLocation({ lat: position.coords.latitude, lng: position.coords.longitude }),
        (error) => {
          console.warn("Location access denied or unavailable:", error.message || error);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }
  }, []);

  const handleLinkLocker = async () => {
    setIsLinking(true);
    await new Promise(r => setTimeout(r, 1500));
    setIsLockerLinked(true);
    setIsLinking(false);
  };

  const handleFetchDoc = async (docId: string) => {
    const doc = vaultDocs.find(d => d.id === docId);
    if (!doc) return;
    setFetchingDocId(docId);
    try {
      const data = await simulateDigiLockerFetch(doc.type);
      setVaultDocs(prev => prev.map(d => d.id === docId ? { 
        ...d, 
        status: 'FETCHED', 
        data, 
        lastUpdated: new Date().toLocaleDateString('en-IN') 
      } : d));
    } catch (e) {
      console.error("Fetch failed", e);
    } finally {
      setFetchingDocId(null);
    }
  };

  const startNewSession = (newMode: Mode) => {
    const newSession: ChatSession = {
      id: Date.now().toString(),
      mode: newMode,
      language: language,
      messages: [],
      timestamp: new Date().toLocaleString(),
      summary: `Session for ${newMode}`
    };
    setActiveSession(newSession);
    setMode(newMode);
  };

  const updateActiveSession = (messages: Message[]) => {
    if (!activeSession) return;
    const updatedSession = { ...activeSession, messages };
    setActiveSession(updatedSession);
    setSessions(prev => {
      const idx = prev.findIndex(s => s.id === activeSession.id);
      if (idx === -1) return [...prev, updatedSession];
      const newSessions = [...prev];
      newSessions[idx] = updatedSession;
      return newSessions;
    });
  };

  const handleEndSession = () => {
    setActiveSession(null);
    setMode(Mode.IDLE);
  };

  const toggleSensitive = (id: string) => {
    setShowSensitive(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className={`min-h-[100dvh] flex flex-col font-sans transition-colors duration-500 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
      
      {/* Dynamic News Ticker with Fixed Badge */}
      <div className="bg-secondary/10 dark:bg-secondary/5 border-b border-secondary/20 backdrop-blur-md py-3 relative z-50 flex items-center">
        {/* Fixed Badge Area */}
        <div className="shrink-0 pl-4 pr-3 z-20 relative flex flex-col items-center justify-center">
          <span className="font-black text-[10px] uppercase tracking-[0.2em] px-3 py-1 bg-secondary text-primary rounded-md shadow-sm whitespace-nowrap flex items-center gap-2">
            <i className="fas fa-satellite-dish animate-pulse"></i>
            {t('tickerUpdates')}
          </span>
          {lastUpdatedTime && (
            <span className="text-[8px] font-bold text-slate-500 dark:text-slate-400 mt-1 uppercase tracking-wide">
               {lastUpdatedTime}
            </span>
          )}
        </div>
        
        {/* Scrolling Content Area with Mask */}
        <div className="flex-1 overflow-hidden relative mask-fade h-6 flex items-center">
            <div className="animate-marquee whitespace-nowrap flex gap-12 items-center absolute left-0">
              {/* Duplicated list for seamless infinite scroll */}
              {[...realTimeUpdates, ...realTimeUpdates, ...realTimeUpdates].map((item, i) => (
                <span key={i} className="text-xs font-bold uppercase tracking-wider flex items-center gap-2 text-slate-700 dark:text-slate-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"></span> 
                  {item}
                </span>
              ))}
            </div>
        </div>
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 glass px-4 md:px-8 py-4 flex justify-between items-center transition-all duration-300">
        <div className="flex items-center gap-4 cursor-pointer group" onClick={() => handleEndSession()}>
          <div className="relative w-10 h-10 group-hover:scale-110 transition-transform duration-300">
             <div className="absolute inset-0 bg-gradient-to-br from-orange-400 to-green-500 rounded-xl blur opacity-40"></div>
             <div className="relative w-full h-full bg-white dark:bg-slate-900 rounded-xl border border-gray-100 dark:border-white/10 flex items-center justify-center shadow-lg">
                <span className="text-xl filter drop-shadow-sm">🇮🇳</span>
             </div>
          </div>
          <div className="flex flex-col">
            <h1 className="text-lg md:text-xl font-black tracking-tight leading-none dark:text-white group-hover:text-secondary transition-colors">
              CivicEase<span className="text-secondary">.AI</span>
            </h1>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{t('heroSubtitle').split('.')[0]}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <button onClick={() => setIsLangOpen(!isLangOpen)} className="h-10 px-4 rounded-full bg-white/50 dark:bg-slate-800/50 border border-gray-200 dark:border-white/10 flex items-center gap-2 hover:bg-white dark:hover:bg-slate-700 transition-all shadow-sm">
              <span className="text-sm font-bold">{LANGUAGES.find(l => l.code === language)?.native}</span>
              <i className="fas fa-chevron-down text-[10px] opacity-50"></i>
            </button>
            {isLangOpen && (
               <>
               <div className="fixed inset-0 z-10" onClick={() => setIsLangOpen(false)}></div>
               <div className="absolute top-12 right-0 bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-gray-100 dark:border-white/5 p-2 w-56 grid grid-cols-1 gap-1 max-h-80 overflow-y-auto z-20 animate-in fade-in slide-in-from-top-2">
                  {LANGUAGES.map(l => (
                    <button key={l.code} onClick={() => { setLanguage(l.code); setIsLangOpen(false); }} className={`p-3 rounded-xl text-left text-sm font-bold flex justify-between items-center transition-colors ${language === l.code ? 'bg-secondary/10 text-secondary' : 'hover:bg-slate-50 dark:hover:bg-white/5 text-slate-600 dark:text-slate-300'}`}>
                       <span>{l.name}</span>
                       <span className="opacity-40 font-medium">{l.native}</span>
                    </button>
                  ))}
               </div>
               </>
            )}
          </div>
          <button onClick={() => setDarkMode(!darkMode)} className="w-10 h-10 rounded-full bg-white/50 dark:bg-slate-800/50 border border-gray-200 dark:border-white/10 flex items-center justify-center hover:bg-white dark:hover:bg-slate-700 transition-all shadow-sm">
            <i className={`fas ${darkMode ? 'fa-sun text-yellow-400' : 'fa-moon text-slate-500'}`}></i>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full relative z-10">
        
        {isChatMode && activeSession ? (
          <div className="h-[calc(100dvh-150px)] animate-page-enter">
            <ChatWindow 
              initialMode={mode}
              language={language}
              vaultDocs={vaultDocs}
              initialMessages={activeSession.messages}
              onMessagesChange={updateActiveSession}
              onReset={handleEndSession}
              onComplete={handleEndSession}
              onFetchDoc={async (id) => handleFetchDoc(id)}
              userLocation={userLocation}
            />
          </div>
        ) : (
          <div className="space-y-12 animate-page-enter pb-20">
            {/* Hero Section */}
            <div className="flex flex-col items-center text-center pt-8 md:pt-16 pb-8 relative">
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] bg-secondary/10 dark:bg-secondary/5 rounded-full blur-[100px] pointer-events-none"></div>
              
              <div className="relative mb-8 animate-float">
                <div className="w-24 h-24 md:w-32 md:h-32 bg-gradient-to-br from-white to-gray-100 dark:from-slate-800 dark:to-slate-900 rounded-[2rem] shadow-2xl flex items-center justify-center rotate-3 border border-white/50 dark:border-white/10">
                   <span className="text-6xl md:text-7xl filter drop-shadow-md">🏛️</span>
                </div>
                <div className="absolute -top-4 -right-4 w-12 h-12 bg-white dark:bg-slate-800 rounded-2xl shadow-lg flex items-center justify-center animate-bounce delay-1000 border border-gray-100 dark:border-white/5">
                   <span className="text-2xl">🇮🇳</span>
                </div>
              </div>

              <h2 className="text-4xl md:text-7xl font-black tracking-tight mb-6 leading-tight max-w-4xl">
                {t('heroTitleLine1')} <span className="text-gradient">{t('heroTitleLine2')}</span>
              </h2>
              <p className="max-w-2xl mx-auto text-slate-500 dark:text-slate-400 text-base md:text-xl font-medium leading-relaxed mb-10">
                {t('heroSubtitle')}
              </p>
              
              <div className="flex flex-wrap justify-center gap-8 md:gap-16 mt-4">
                 {[
                   { label: t('statCitizens'), val: '3.2M+', icon: 'fa-users' },
                   { label: t('statLanguages'), val: '12', icon: 'fa-language' },
                   { label: t('statOffices'), val: '450k+', icon: 'fa-building' }
                 ].map((stat, i) => (
                    <div key={i} className="flex flex-col items-center gap-2 group cursor-default">
                        <div className="w-12 h-12 rounded-full bg-secondary/10 flex items-center justify-center text-secondary mb-1 group-hover:scale-110 transition-transform">
                            <i className={`fas ${stat.icon}`}></i>
                        </div>
                        <h3 className="text-lg font-black dark:text-white">{stat.val}</h3>
                        <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">{stat.label.split(' ')[1] || stat.label}</p>
                    </div>
                 ))}
              </div>
            </div>

            {/* Action Grid */}
            <div>
              <div className="flex items-center gap-4 mb-6 px-2">
                 <div className="h-px flex-1 bg-gradient-to-r from-transparent via-slate-200 dark:via-slate-700 to-transparent"></div>
                 <h3 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">{t('assistant')}</h3>
                 <div className="h-px flex-1 bg-gradient-to-r from-transparent via-slate-200 dark:via-slate-700 to-transparent"></div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
                {[
                  { m: Mode.FORM_FILLING, icon: 'fa-file-signature', grad: 'from-blue-500 to-indigo-600', title: 'formAssistant', desc: 'formDesc' },
                  { m: Mode.PROBLEM_REPORTING, icon: 'fa-camera-retro', grad: 'from-orange-500 to-red-600', title: 'civicReporter', desc: 'civicDesc' },
                  { m: Mode.SCHEME_FINDER, icon: 'fa-gift', grad: 'from-green-500 to-emerald-600', title: 'schemeFinder', desc: 'schemeDesc' },
                  { m: Mode.OFFICE_LOCATOR, icon: 'fa-map-marked-alt', grad: 'from-purple-500 to-pink-600', title: 'officeLocator', desc: 'officeDesc' }
                ].map((item) => (
                  <button 
                    key={item.m} 
                    onClick={() => startNewSession(item.m)}
                    className="group relative h-64 p-6 rounded-[2rem] glass-card text-left hover-lift overflow-hidden transition-all duration-300"
                  >
                    <div className={`absolute -right-4 -top-4 w-32 h-32 rounded-full bg-gradient-to-br ${item.grad} opacity-10 group-hover:opacity-20 blur-2xl transition-all duration-500 group-hover:scale-150`}></div>
                    
                    <div className="relative z-10 h-full flex flex-col">
                        <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${item.grad} flex items-center justify-center text-white shadow-lg mb-auto group-hover:rotate-6 transition-transform duration-300`}>
                          <i className={`fas ${item.icon} text-xl`}></i>
                        </div>
                        
                        <div>
                           <h3 className="text-xl font-black mb-2 dark:text-white group-hover:text-transparent group-hover:bg-clip-text group-hover:bg-gradient-to-r group-hover:from-slate-900 group-hover:to-slate-600 dark:group-hover:from-white dark:group-hover:to-slate-300 transition-all">{t(item.title)}</h3>
                           <p className="text-xs font-medium text-slate-500 dark:text-slate-400 leading-relaxed line-clamp-2">{t(item.desc)}</p>
                        </div>

                        <div className="absolute bottom-6 right-6 opacity-0 group-hover:opacity-100 transform translate-x-4 group-hover:translate-x-0 transition-all duration-300">
                           <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-primary dark:text-white shadow-md">
                              <i className="fas fa-arrow-right"></i>
                           </div>
                        </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* DigiLocker Vault */}
            <div className="relative group">
                <div className="absolute inset-0 bg-gradient-to-r from-slate-900 to-slate-800 rounded-[2.5rem] shadow-2xl transform transition-transform group-hover:scale-[1.01]"></div>
                
                <div className="relative p-6 md:p-12 text-white overflow-hidden rounded-[2.5rem]">
                    <div className="absolute top-0 right-0 p-12 opacity-5 pointer-events-none">
                        <i className="fas fa-shield-alt text-[12rem]"></i>
                    </div>

                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6">
                        <div>
                            <div className="flex items-center gap-3 mb-3">
                                <div className="px-3 py-1 bg-green-500/20 rounded-full border border-green-500/30 text-[10px] font-black uppercase tracking-widest flex items-center gap-2 text-green-400">
                                   <div className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></div> {t('securedBy')} Gov.in
                                </div>
                            </div>
                            <h3 className="text-3xl md:text-4xl font-black tracking-tight">{t('vaultTitle')}</h3>
                            <p className="text-slate-400 text-sm mt-2 max-w-md">{t('lockerRequiredDesc')}</p>
                        </div>
                        
                        {!isLockerLinked ? (
                            <button onClick={handleLinkLocker} disabled={isLinking} className="relative overflow-hidden px-8 py-4 bg-white text-slate-900 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-slate-100 transition-all shadow-xl hover:shadow-2xl active:scale-95 group/btn">
                                <span className="relative z-10 flex items-center gap-3">
                                   {isLinking ? <i className="fas fa-circle-notch fa-spin"></i> : <i className="fas fa-link"></i>}
                                   {t('linkLocker')}
                                </span>
                                {isLinking && <div className="absolute inset-0 shimmer-bg"></div>}
                            </button>
                        ) : (
                            <div className="flex items-center gap-3 px-6 py-3 bg-green-500/10 border border-green-500/20 rounded-2xl text-green-400 font-bold text-xs uppercase tracking-widest">
                                <span className="w-6 h-6 rounded-full bg-green-500 text-white flex items-center justify-center text-[10px]"><i className="fas fa-check"></i></span>
                                {t('govtVerified')}
                            </div>
                        )}
                    </div>

                    {!isLockerLinked ? (
                       <div className="h-48 flex flex-col items-center justify-center border-2 border-dashed border-white/10 rounded-3xl bg-white/5 animate-pulse-slow">
                          <i className="fas fa-lock text-3xl text-white/20 mb-4"></i>
                          <p className="text-white/30 font-bold text-sm text-center px-4">{t('lockerRequiredTitle')}</p>
                       </div>
                    ) : (
                       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {vaultDocs.map(doc => (
                              <div key={doc.id} className="relative bg-white/5 border border-white/10 hover:bg-white/10 p-5 rounded-2xl transition-all hover:-translate-y-1 group/doc overflow-hidden">
                                  {/* ID Card Look */}
                                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-indigo-500 opacity-50"></div>
                                  
                                  <div className="flex justify-between items-start mb-4">
                                      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center shadow-inner border border-white/5">
                                          <i className={`fas ${doc.type === 'AADHAAR' ? 'fa-fingerprint text-pink-400' : doc.type === 'PAN' ? 'fa-id-card text-blue-400' : 'fa-file-alt text-orange-400'}`}></i>
                                      </div>
                                      {doc.status === 'NOT_FETCHED' ? (
                                          <button onClick={() => handleFetchDoc(doc.id)} disabled={!!fetchingDocId} className="px-3 py-1.5 bg-secondary/10 hover:bg-secondary/20 text-secondary rounded-lg text-[10px] font-bold uppercase tracking-wide transition-colors">
                                              {fetchingDocId === doc.id ? <i className="fas fa-circle-notch fa-spin"></i> : t('fetch')}
                                          </button>
                                      ) : (
                                          <div className="px-2 py-1 bg-green-500/20 rounded-md">
                                             <i className="fas fa-check text-green-400 text-[10px]"></i>
                                          </div>
                                      )}
                                  </div>
                                  
                                  <h4 className="font-bold text-base mb-1 tracking-tight text-white/90">{t(doc.type.toLowerCase())}</h4>
                                  <p className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Government of India</p>
                                  
                                  {doc.status === 'FETCHED' && doc.data ? (
                                      <div className="space-y-3 mt-4 pt-4 border-t border-white/5">
                                          {Object.entries(doc.data).slice(0, 2).map(([k, v]) => (
                                              <div key={k} className="flex justify-between items-center text-xs">
                                                  <span className="text-white/30 font-medium capitalize">{k.replace(/_/g, ' ').split(' ')[0]}</span>
                                                  <div className="flex items-center gap-2">
                                                      <span className="font-mono text-white/80 bg-black/20 px-2 py-0.5 rounded">{showSensitive[doc.id] ? v : '•••• ••••'}</span>
                                                      <button onClick={() => toggleSensitive(doc.id)} className="text-white/20 hover:text-white transition-colors"><i className={`fas ${showSensitive[doc.id] ? 'fa-eye-slash' : 'fa-eye'}`}></i></button>
                                                  </div>
                                              </div>
                                          ))}
                                          <div className="pt-2 flex justify-between items-end">
                                              <img src="https://upload.wikimedia.org/wikipedia/commons/5/55/Emblem_of_India.svg" className="w-4 opacity-50 invert" alt="Emblem" />
                                              <div className="text-[9px] text-white/20 uppercase font-bold">{doc.lastUpdated}</div>
                                          </div>
                                      </div>
                                  ) : (
                                      <div className="mt-4 pt-4 border-t border-white/5">
                                          <div className="h-2 w-1/2 bg-white/5 rounded-full mb-2"></div>
                                          <div className="h-2 w-3/4 bg-white/5 rounded-full"></div>
                                      </div>
                                  )}
                              </div>
                          ))}
                       </div>
                    )}
                </div>
            </div>

            {/* History Grid */}
            {sessions.length > 0 && (
              <div className="pt-8">
                 <div className="flex items-center justify-between mb-8 px-2">
                    <h3 className="text-2xl font-black">{t('history')}</h3>
                    <button onClick={() => setSessions([])} className="text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-1 rounded-lg transition-colors">Clear All</button>
                 </div>
                 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {sessions.map(session => (
                       <div key={session.id} onClick={() => { setActiveSession(session); setMode(session.mode); setLanguage(session.language); }} className="bg-white/50 dark:bg-slate-800/50 backdrop-blur-sm border border-gray-100 dark:border-white/5 p-5 rounded-2xl cursor-pointer hover:border-secondary/50 transition-all hover:shadow-md group">
                           <div className="flex justify-between items-start mb-3">
                               <span className="px-2 py-1 bg-slate-100 dark:bg-slate-700/50 rounded-md text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">{t(session.mode.toLowerCase().replace('_', '') + 'Assistant')}</span>
                               <span className="text-[10px] font-bold text-slate-400">{session.timestamp.split(',')[0]}</span>
                           </div>
                           <p className="text-sm font-medium text-slate-600 dark:text-slate-300 line-clamp-2 leading-relaxed">{session.messages[session.messages.length - 1]?.content || 'No messages'}</p>
                           <div className="mt-4 flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                               <span className="text-secondary text-xs font-bold flex items-center gap-1">Resume <i className="fas fa-arrow-right"></i></span>
                           </div>
                       </div>
                    ))}
                 </div>
              </div>
            )}
            
            {/* Footer */}
            <footer className="text-center py-12 border-t border-gray-200 dark:border-white/5 mt-12">
                <div className="flex flex-wrap justify-center gap-4 mb-8">
                    {[t('footerMadeIn'), t('footerMakeIn'), t('footerTrusted')].map((tag, i) => (
                        <span key={i} className="px-4 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-white/5 text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">
                           {tag}
                        </span>
                    ))}
                </div>
                <div className="flex justify-center items-center gap-2 text-slate-400 mb-2">
                   <i className="fas fa-code text-xs"></i>
                   <span className="text-xs font-bold">Built with Google Gemini 2.5 & 3.0 Models</span>
                </div>
                <p className="text-xs font-medium text-slate-400/60">© 2024 CivicEase AI. {t('footerDevCraft')}.</p>
            </footer>

          </div>
        )}
      </main>
    </div>
  );
};

export default App;