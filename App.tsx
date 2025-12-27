
import React, { useState, useEffect } from 'react';
import { Mode, Language, LANGUAGES, VaultDoc, ChatSession, Message } from './types';
import { translations } from './translations';
import ChatWindow from './components/ChatWindow';
import { simulateDigiLockerFetch } from './services/geminiService';
import { GoogleGenAI, Type } from "@google/genai";

const STORAGE_KEY = 'civic_ease_sessions_v3';

const App: React.FC = () => {
  const [mode, setMode] = useState<Mode>(Mode.IDLE);
  const [language, setLanguage] = useState<Language>('en');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [realTimeUpdates, setRealTimeUpdates] = useState<string[]>([]);
  
  const [vaultDocs, setVaultDocs] = useState<VaultDoc[]>([
    { id: '1', name: 'Aadhaar', type: 'AADHAAR', status: 'NOT_FETCHED' },
    { id: '2', name: 'PAN', type: 'PAN', status: 'NOT_FETCHED' },
    { id: '3', name: 'License', type: 'DL', status: 'NOT_FETCHED' },
    { id: '4', name: 'Voter ID', type: 'VOTER_ID', status: 'NOT_FETCHED' },
    { id: '5', name: 'Ration Card', type: 'RATION_CARD', status: 'NOT_FETCHED' },
    { id: '6', name: 'covid_cert', type: 'COVID_CERT', status: 'NOT_FETCHED' },
    { id: '7', name: 'class_x_mark', type: 'CLASS_X_MARK', status: 'NOT_FETCHED' }
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
    if (saved) {
      try {
        setSessions(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse sessions", e);
      }
    }
  }, []);

  useEffect(() => {
    const fetchLiveNews = async () => {
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: `Provide the 5 most recent Indian government news updates. Max 8 words each. Translate them all into ${LANGUAGES.find(l => l.code === language)?.name}. Return strictly as a JSON string array.`,
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
        (error) => console.error("Location access denied", error),
        { enableHighAccuracy: true }
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
      const idx = prev.findIndex(s => s.id === updatedSession.id);
      if (idx >= 0) {
        const newSessions = [...prev];
        newSessions[idx] = updatedSession;
        return newSessions;
      }
      return [updatedSession, ...prev];
    });
  };

  const deleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("Delete this session?")) {
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    }
  };

  const resumeSession = (session: ChatSession) => {
    setActiveSession(session);
    setMode(session.mode);
    setLanguage(session.language);
  };

  const renderHistory = () => (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-6xl mx-auto py-6 px-4 mb-24">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
        <div className="text-left">
          <h2 className="text-3xl md:text-5xl font-black text-primary dark:text-white tracking-tighter">{t('history')}</h2>
          <p className="text-sm md:text-lg text-gray-500 dark:text-gray-400 font-medium mt-2">Resume your previous tasks.</p>
        </div>
        <button onClick={() => setMode(Mode.IDLE)} className="px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest text-primary dark:text-white bg-white dark:bg-slate-800 border-2 border-gray-200 dark:border-slate-700 shadow-sm">{t('close')}</button>
      </div>
      <div className="grid grid-cols-1 gap-4">
        {sessions.length === 0 && <p className="text-center text-gray-400 font-bold py-10">No history found.</p>}
        {sessions.map(session => (
          <div key={session.id} onClick={() => resumeSession(session)} className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] shadow-sm border-2 border-gray-200 dark:border-slate-700 hover-lift cursor-pointer flex justify-between items-center group">
            <div className="flex gap-4 items-center">
              <div className="w-12 h-12 rounded-2xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-secondary">
                <i className="fas fa-history"></i>
              </div>
              <div>
                <h4 className="font-black text-primary dark:text-white uppercase tracking-tight text-sm">{t(session.mode.toLowerCase().replace('_', '') + 'Assistant')}</h4>
                <p className="text-[10px] text-gray-400 font-black uppercase tracking-widest mt-0.5">{session.timestamp}</p>
              </div>
            </div>
            <button onClick={(e) => deleteSession(session.id, e)} className="w-10 h-10 rounded-xl text-gray-300 hover:text-red-500 transition-all"><i className="fas fa-trash-can text-sm"></i></button>
          </div>
        ))}
      </div>
    </div>
  );

  const renderVault = () => (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-6xl mx-auto py-6 px-4 mb-24">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
        <div className="text-left">
          <h2 className="text-3xl md:text-5xl font-black text-primary dark:text-white tracking-tighter">{t('vaultTitle')}</h2>
          <p className="text-sm md:text-lg text-gray-500 dark:text-gray-400 font-medium mt-2">{t('securedBy')} DigiLocker Gateway</p>
        </div>
        <button onClick={() => setMode(Mode.IDLE)} className="px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest text-primary dark:text-white bg-white dark:bg-slate-800 border-2 border-gray-200 dark:border-slate-700 shadow-sm">{t('close')}</button>
      </div>

      {!isLockerLinked ? (
        <div className="bg-white dark:bg-slate-900 p-8 md:p-12 rounded-[2.5rem] border-2 border-dashed border-gray-200 dark:border-slate-700 text-center relative overflow-hidden">
          {isLinking && <div className="absolute inset-0 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md z-10 flex flex-col items-center justify-center animate-pulse"><p className="text-[10px] font-black uppercase tracking-widest text-primary dark:text-white">{t('authenticating')}</p></div>}
          <div className="w-20 h-20 bg-amber-50 dark:bg-amber-950/20 rounded-full flex items-center justify-center mx-auto mb-6"><i className="fas fa-shield-halved text-3xl text-secondary"></i></div>
          <h3 className="text-xl font-black text-primary dark:text-white mb-3">{t('lockerRequiredTitle')}</h3>
          <p className="text-sm text-gray-500 max-w-md mx-auto mb-8">{t('lockerRequiredDesc')}</p>
          <button onClick={handleLinkLocker} className="bg-primary text-white px-10 py-4 rounded-xl font-black uppercase tracking-widest text-[10px] shadow-xl">{t('linkLocker')}</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
          {vaultDocs.map((doc) => (
            <div key={doc.id} className="bg-white dark:bg-slate-900 p-6 md:p-8 rounded-[2rem] border-2 border-gray-200 dark:border-slate-700 flex flex-col group shadow-sm">
              <div className="flex justify-between items-center mb-6">
                <div className="flex gap-4 items-center">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${doc.status === 'FETCHED' ? 'bg-secondary/10 text-secondary' : 'bg-slate-50 dark:bg-slate-800 text-gray-400'}`}>
                    <i className={`fas ${doc.type === 'AADHAAR' ? 'fa-fingerprint' : doc.type === 'DL' ? 'fa-car' : doc.type === 'COVID_CERT' ? 'fa-syringe' : doc.type === 'CLASS_X_MARK' ? 'fa-graduation-cap' : 'fa-id-card'}`}></i>
                  </div>
                  <div>
                    <h4 className="font-black text-primary dark:text-white text-sm uppercase">{t(doc.name.toLowerCase())}</h4>
                    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{doc.status === 'FETCHED' ? t('govtVerified') : t('awaitingLink')}</span>
                  </div>
                </div>
                {doc.status !== 'FETCHED' ? (
                  <button onClick={() => handleFetchDoc(doc.id)} disabled={fetchingDocId === doc.id} className="bg-primary text-white px-5 py-2 rounded-lg text-[9px] font-black uppercase">
                    {fetchingDocId === doc.id ? <i className="fas fa-spinner animate-spin"></i> : t('fetch')}
                  </button>
                ) : (
                   <div className="w-8 h-8 rounded-full bg-green-500/10 flex items-center justify-center"><i className="fas fa-check text-green-500 text-xs"></i></div>
                )}
              </div>
              {doc.status === 'FETCHED' && doc.data && (
                <div className="bg-slate-50 dark:bg-slate-950 rounded-xl p-4 space-y-2">
                  {Object.entries(doc.data).slice(0, 3).map(([k, v]) => (
                    <div key={k} className="flex justify-between text-[10px] font-bold"><span className="text-gray-400 uppercase">{k}</span><span className="text-primary dark:text-white">{String(v)}</span></div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col bg-slate-100 dark:bg-[#020617] transition-colors duration-500 overflow-x-hidden relative">
      
      {/* Fixed Header Group */}
      <header className="fixed top-0 left-0 w-full z-[120] shadow-sm flex flex-col">
        {/* Real-time Ticker */}
        <div className="w-full bg-primary-light dark:bg-slate-950 py-2.5 overflow-hidden flex items-center border-b border-white/5 relative z-[121]">
            <div className="px-6 flex-shrink-0"><span className="text-[9px] font-black uppercase tracking-widest text-secondary flex items-center gap-2"><i className="fas fa-bolt"></i> {t('tickerUpdates')}</span></div>
            <div className="flex-1 overflow-hidden whitespace-nowrap">
                <div className="inline-block animate-marquee">
                    {realTimeUpdates.concat(realTimeUpdates).map((update, idx) => (
                      <span key={idx} className="text-[10px] font-bold text-white/60 mx-10 uppercase tracking-tight">• {update}</span>
                    ))}
                </div>
            </div>
        </div>

        {/* Top Nav (Desktop) */}
        <nav className="w-full glass px-6 md:px-12 py-4 flex justify-between items-center backdrop-blur-xl bg-white/80 dark:bg-slate-900/90 border-b border-white/20 dark:border-white/5 relative z-[120]">
          <div className="flex items-center gap-3 cursor-pointer group" onClick={() => setMode(Mode.IDLE)}>
            <div className="bg-primary p-2.5 rounded-xl shadow-lg transition-transform group-hover:rotate-12"><i className="fas fa-landmark-flag text-secondary"></i></div>
            <h1 className="text-xl md:text-2xl font-black tracking-tighter text-primary dark:text-white">Civic<span className="text-secondary italic">Ease</span></h1>
          </div>
          
          <div className="flex items-center gap-3 md:gap-4">
             {/* Desktop Menu Links */}
             <div className="hidden md:flex items-center gap-2 mr-2">
                <button onClick={() => setMode(Mode.DIGILOCKER)} className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${mode === Mode.DIGILOCKER ? 'bg-secondary text-primary' : 'text-gray-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                  {t('vault')}
                </button>
                <button onClick={() => setMode(Mode.HISTORY)} className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${mode === Mode.HISTORY ? 'bg-secondary text-primary' : 'text-gray-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                  {t('history')}
                </button>
             </div>

             <button onClick={() => setIsLangOpen(true)} className="h-10 px-4 rounded-xl flex items-center gap-2 bg-slate-50 dark:bg-slate-800 text-primary dark:text-white border-2 border-gray-200 dark:border-slate-700 transition-all hover:border-secondary shadow-sm">
               <i className="fas fa-language text-secondary text-lg"></i> 
               <span className="text-[10px] font-black uppercase tracking-widest">{LANGUAGES.find(l => l.code === language)?.native}</span>
             </button>
             <button onClick={() => setDarkMode(!darkMode)} className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-slate-800 text-primary dark:text-secondary flex items-center justify-center transition-all shadow-sm"><i className={`fas ${darkMode ? 'fa-sun' : 'fa-moon'}`}></i></button>
          </div>
        </nav>
      </header>

      {/* COMPACT Language Modal (Z-index high enough to cover fixed header) */}
      {isLangOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsLangOpen(false)}></div>
          <div className="relative bg-white dark:bg-slate-900 w-full max-w-lg rounded-[2rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border-2 border-gray-200 dark:border-slate-700">
            <div className="p-6 border-b border-gray-50 dark:border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-black text-primary dark:text-white italic">{t('selectLanguage')}</h3>
              <button onClick={() => setIsLangOpen(false)} className="w-8 h-8 rounded-lg bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-gray-400"><i className="fas fa-times"></i></button>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3 max-h-[60dvh] overflow-y-auto">
              {LANGUAGES.map(lang => (
                <button 
                  key={lang.code} 
                  onClick={() => { setLanguage(lang.code); setIsLangOpen(false); }} 
                  className={`p-4 rounded-2xl text-left border-2 transition-all ${language === lang.code ? 'bg-primary text-white border-primary shadow-lg' : 'bg-slate-50 dark:bg-slate-800 border-transparent text-gray-600 dark:text-gray-300 hover:border-secondary'}`}
                >
                  <p className="text-xl font-black">{lang.native}</p>
                  <p className="text-[8px] font-black uppercase tracking-widest opacity-60 mt-1">{lang.name}</p>
                </button>
              ))}
            </div>
            <div className="p-6 bg-slate-50 dark:bg-slate-950 text-center"><p className="text-[8px] font-black uppercase tracking-[0.4em] text-gray-400">{t('footerTrusted')}</p></div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {/* 
         Logic: If we are in a specific Chat Mode, we fix the main container to the viewport 
         (fixed inset-0 with top padding). This prevents the entire page body from scrolling,
         ensuring ONLY the chat content flows.
         
         If we are in IDLE, Vault, or History, we allow normal page flow.
      */}
      <main className={`w-full flex-1 flex flex-col items-center px-4 transition-all duration-300 ${isChatMode ? 'fixed inset-x-0 bottom-0 top-[130px] md:top-[144px] overflow-hidden pb-4 md:pb-6 z-10' : 'pt-36 md:pt-40 pb-24 md:pb-10'}`}>
        <div className={`w-full max-w-6xl ${isChatMode ? 'h-full' : ''}`}>
          {mode === Mode.DIGILOCKER ? renderVault() : mode === Mode.HISTORY ? renderHistory() : mode === Mode.IDLE ? (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
              <div className="text-center space-y-8 max-w-5xl mx-auto mb-12 md:mb-16">
                <h2 className="text-4xl md:text-8xl font-black text-primary dark:text-white leading-tight tracking-tighter">
                  {t('heroTitleLine1')} <br/> 
                  <span className="text-transparent bg-clip-text bg-gradient-to-br from-secondary to-orange-600 italic">{t('heroTitleLine2')}</span>
                </h2>
                <p className="text-sm md:text-xl text-gray-500 dark:text-gray-400 font-medium max-w-2xl mx-auto leading-relaxed">{t('heroSubtitle')}</p>
                <div className="flex flex-wrap justify-center gap-4 mt-8 md:mt-10">
                   <div className="px-4 py-2 md:px-6 md:py-3 bg-white dark:bg-slate-900 rounded-2xl border-2 border-gray-200 dark:border-slate-700 flex items-center gap-3 shadow-sm">
                      <i className="fas fa-users text-secondary"></i>
                      <span className="text-[10px] font-black uppercase tracking-widest text-primary dark:text-white">{t('statCitizens')}</span>
                   </div>
                   <div className="px-4 py-2 md:px-6 md:py-3 bg-white dark:bg-slate-900 rounded-2xl border-2 border-gray-200 dark:border-slate-700 flex items-center gap-3 shadow-sm">
                      <i className="fas fa-language text-secondary"></i>
                      <span className="text-[10px] font-black uppercase tracking-widest text-primary dark:text-white">{t('statLanguages')}</span>
                   </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
                {[
                  { m: Mode.FORM_FILLING, t: 'formAssistant', d: 'formDesc', icon: 'fa-file-signature', badge: 'badgeAutomated' },
                  { m: Mode.PROBLEM_REPORTING, t: 'civicReporter', d: 'civicDesc', icon: 'fa-camera-rotate', badge: 'badgeVerified' },
                  { m: Mode.SCHEME_FINDER, t: 'schemeFinder', d: 'schemeDesc', icon: 'fa-hand-holding-heart', badge: 'badgeSmart' },
                  { m: Mode.OFFICE_LOCATOR, t: 'officeLocator', d: 'officeDesc', icon: 'fa-map-location-dot', badge: 'badgeGeo' }
                ].map((item, idx) => (
                  <div key={idx} onClick={() => startNewSession(item.m)} className="group bg-white dark:bg-slate-900 rounded-[2rem] md:rounded-[2.5rem] p-6 md:p-12 shadow-sm border-2 border-gray-200 dark:border-slate-700 flex flex-col min-h-[220px] md:min-h-[250px] relative overflow-hidden active:scale-95 transition-all duration-500 cursor-pointer hover:shadow-2xl">
                    <div className="absolute top-6 right-6 md:top-8 md:right-8 px-3 py-1 rounded-full bg-slate-50 dark:bg-slate-800 text-[8px] font-black uppercase tracking-widest text-gray-400 border border-gray-100 dark:border-slate-800">{t(item.badge)}</div>
                    <div className="bg-slate-50 dark:bg-slate-800 w-12 h-12 md:w-16 md:h-16 rounded-2xl flex items-center justify-center mb-6 md:mb-8 shadow-inner group-hover:scale-110 transition-transform"><i className={`fas ${item.icon} text-xl md:text-2xl text-secondary`}></i></div>
                    <h3 className="text-xl md:text-3xl font-black text-primary dark:text-white mb-2 tracking-tighter">{t(item.t)}</h3>
                    <p className="text-gray-400 dark:text-gray-500 text-sm md:text-base font-bold leading-relaxed mb-6 md:mb-10 max-w-sm">{t(item.d)}</p>
                    <div className="mt-auto text-[10px] font-black uppercase tracking-widest text-secondary flex items-center gap-2 group-hover:gap-4 transition-all">{t('start')} <i className="fas fa-arrow-right"></i></div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto w-full h-full"><ChatWindow initialMode={mode} language={language} vaultDocs={vaultDocs} initialMessages={activeSession?.messages || []} onMessagesChange={updateActiveSession} onReset={() => { setMode(Mode.IDLE); setActiveSession(null); }} onComplete={() => { setMode(Mode.IDLE); setActiveSession(null); }} onFetchDoc={handleFetchDoc} userLocation={userLocation}/></div>
          )}
        </div>
      </main>

      {/* Mobile Bottom Navigation - Hidden during Chat Mode to maximize space and prevent scroll overlap */}
      {!isChatMode && (
        <div className="md:hidden fixed bottom-0 left-0 right-0 glass border-t border-gray-200 dark:border-slate-800 pb-[env(safe-area-inset-bottom)] z-[150] flex justify-between px-8 py-4 bg-white/90 dark:bg-slate-950/90 backdrop-blur-xl animate-in slide-in-from-bottom-full duration-500">
            <button onClick={() => setMode(Mode.IDLE)} className={`flex flex-col items-center gap-1.5 ${mode === Mode.IDLE || (mode !== Mode.DIGILOCKER && mode !== Mode.HISTORY) ? 'text-secondary scale-110' : 'text-gray-400'} transition-all`}>
                <i className="fas fa-house text-xl"></i>
                <span className="text-[9px] font-black uppercase tracking-wider">Home</span>
            </button>
            <button onClick={() => setMode(Mode.DIGILOCKER)} className={`flex flex-col items-center gap-1.5 ${mode === Mode.DIGILOCKER ? 'text-secondary scale-110' : 'text-gray-400'} transition-all`}>
                <i className="fas fa-shield-halved text-xl"></i>
                <span className="text-[9px] font-black uppercase tracking-wider">Vault</span>
            </button>
            <button onClick={() => setMode(Mode.HISTORY)} className={`flex flex-col items-center gap-1.5 ${mode === Mode.HISTORY ? 'text-secondary scale-110' : 'text-gray-400'} transition-all`}>
                <i className="fas fa-clock-rotate-left text-xl"></i>
                <span className="text-[9px] font-black uppercase tracking-wider">History</span>
            </button>
        </div>
      )}

      {/* Footer - Hidden during Chat Mode */}
      {!isChatMode && (
        <footer className="w-full py-12 md:py-20 px-6 bg-slate-50 dark:bg-slate-900/50 border-t border-gray-100 dark:border-slate-800 flex flex-col items-center gap-8 md:gap-12 text-center mb-24 md:mb-0">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-24 max-w-4xl w-full">
                <div className="flex flex-col items-center md:items-start gap-3">
                    <span className="text-[10px] font-black uppercase tracking-[0.4em] text-gray-400">{t('footerDevCraft')}</span>
                    <div className="flex flex-col md:flex-row items-center gap-4 md:gap-8">
                        <h4 className="text-[10px] md:text-sm font-black text-primary dark:text-white uppercase border border-gray-200 dark:border-slate-800 px-4 py-2 rounded-lg bg-white dark:bg-slate-900 shadow-sm">{t('footerMadeIn')}</h4>
                        <h4 className="text-[10px] md:text-sm font-black text-primary dark:text-white uppercase border border-gray-200 dark:border-slate-800 px-4 py-2 rounded-lg bg-white dark:bg-slate-900 shadow-sm">{t('footerMakeIn')}</h4>
                    </div>
                </div>
                <div className="flex flex-col items-center md:items-end gap-3">
                    <span className="text-[10px] font-black uppercase tracking-[0.4em] text-gray-400">{t('footerTrust')}</span>
                    <div className="flex flex-col md:flex-row items-center gap-4">
                        <h4 className="text-[10px] md:text-sm font-black text-primary dark:text-white uppercase border border-gray-200 dark:border-slate-800 px-4 py-2 rounded-lg bg-white dark:bg-slate-900 shadow-sm">{t('footerTrusted')}</h4>
                    </div>
                </div>
            </div>

            <div className="flex flex-col items-center gap-2">
                <span className="text-[10px] font-black tracking-[0.6em] text-gray-400 uppercase">{t('footerPowered')}</span>
                <h5 className="text-xl md:text-3xl font-black text-primary dark:text-white tracking-tighter italic uppercase">GEMINI <span className="text-secondary">3.0</span> NATIVE</h5>
            </div>

            <p className="text-[10px] md:text-[10px] font-black uppercase tracking-[0.4em] text-gray-400 opacity-50 pt-4">© 2025 CIVICEASE INDIA • ALL RIGHTS SECURED</p>
        </footer>
      )}
    </div>
  );
};

export default App;
