import React, { useState, useEffect, useRef } from 'react';
import { Message, Mode, Language, VaultDoc, LANGUAGES, FormAnalysis } from '../types';
import { 
    analyzeFormImage, 
    analyzeProblemImage, 
    findNearbyOffices, 
    findGovSchemes, 
    suggestVaultPreFill
} from '../services/geminiService';
import { GoogleGenAI, Modality, LiveServerMessage, Type, FunctionDeclaration, GenerateContentResponse } from '@google/genai';
import { translations } from '../translations';

interface ChatWindowProps {
  initialMode: Mode;
  language: Language;
  vaultDocs: VaultDoc[];
  initialMessages?: Message[];
  onMessagesChange?: (messages: Message[]) => void;
  onReset: () => void;
  onComplete: () => void;
  onFetchDoc: (docId: string) => Promise<any>;
  userLocation: { lat: number; lng: number } | null;
}

interface FormState {
  title: string;
  fields: { name: string; value: string; section: string }[];
  isCollapsed: boolean;
}

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const getApiKey = () => (window as any).API_KEY || process.env.API_KEY;

const ChatWindow: React.FC<ChatWindowProps> = ({ 
  initialMode, 
  language, 
  vaultDocs, 
  initialMessages = [], 
  onMessagesChange,
  onReset, 
  onComplete,
  onFetchDoc,
  userLocation 
}) => {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [voiceVolume, setVoiceVolume] = useState(0);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const liveSessionRef = useRef<any>(null);
  const audioContextsRef = useRef<{ out: AudioContext | null, in: AudioContext | null }>({ out: null, in: null });
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<any>(null);
  const processedTagsRef = useRef<Set<string>>(new Set());

  const liveTurnIds = useRef<{ user: string | null, assistant: string | null }>({ user: null, assistant: null });

  const currentLangName = LANGUAGES.find(l => l.code === language)?.name || 'English';
  const currentLangNative = LANGUAGES.find(l => l.code === language)?.native || 'English';

  const t = (key: string, variables?: Record<string, string>) => {
    let text = translations[language]?.[key] || translations['en']?.[key] || key;
    if (variables) {
      Object.entries(variables).forEach(([k, v]) => {
        text = text.replace(`{${k}}`, v);
      });
    }
    return text;
  };

  const showError = (msg: string) => {
    setErrorToast(msg);
  };

  useEffect(() => {
    if (errorToast) {
        const timer = setTimeout(() => setErrorToast(null), 4000);
        return () => clearTimeout(timer);
    }
  }, [errorToast]);

  useEffect(() => {
    if (messages.length === 0) {
      const modeName = t(initialMode.toLowerCase().replace('_', '') + 'Assistant') || t('assistant');
      setMessages([{ id: 'init', role: 'assistant', content: t('welcomeMessage', { mode: modeName }) }]);
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    if (onMessagesChange) onMessagesChange(messages);
  }, [messages]);

  useEffect(() => {
    return () => { stopLiveSession(); };
  }, []);

  useEffect(() => {
    if (isLiveActive) {
      stopLiveSession();
      // Allow cleanup to finish before restart
      setTimeout(() => toggleLiveVoice(), 500);
    }
  }, [language]);

  useEffect(() => {
    if (isLiveActive && isCameraOpen && videoRef.current && liveSessionRef.current) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        frameIntervalRef.current = setInterval(async () => {
            if (videoRef.current && ctx) {
                // Reduce resolution for bandwidth optimization (approx 426x240)
                canvas.width = videoRef.current.videoWidth / 3;
                canvas.height = videoRef.current.videoHeight / 3;
                ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
                // Lower quality to 0.4 for faster transmission
                const base64 = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
                
                // Only send if session is connected
                liveSessionRef.current.sendRealtimeInput({
                    media: { mimeType: "image/jpeg", data: base64 }
                });
            }
        }, 1000); // 1 FPS
    } else {
        if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    }

    return () => {
        if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    };
  }, [isLiveActive, isCameraOpen]);

  const toggleLiveVoice = async () => {
    if (isLiveActive) { stopLiveSession(); return; }
    
    setLoading(true);
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const outCtx = new AudioContextClass({ sampleRate: 24000 });
      const inCtx = new AudioContextClass({ sampleRate: 16000 });
      
      // Resume contexts immediately to handle autoplay policies
      await outCtx.resume();
      await inCtx.resume();
      audioContextsRef.current = { out: outCtx, in: inCtx };

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 16000 } 
      });
      streamRef.current = stream;

      const apiKey = getApiKey();
      if (!apiKey) throw new Error("API Key Missing");
      const ai = new GoogleGenAI({ apiKey });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setIsLiveActive(true);
            setLoading(false);
            const source = inCtx.createMediaStreamSource(stream);
            const processor = inCtx.createScriptProcessor(4096, 1, 1);
            const analyser = inCtx.createAnalyser();
            analyser.fftSize = 256;
            analyserRef.current = analyser;
            source.connect(analyser);

            const viz = () => {
              if (!analyserRef.current) return;
              const data = new Uint8Array(analyserRef.current.frequencyBinCount);
              analyserRef.current.getByteFrequencyData(data);
              const vol = data.reduce((a, b) => a + b) / data.length;
              setVoiceVolume(vol);
              if (audioContextsRef.current.in?.state === 'running') {
                  requestAnimationFrame(viz);
              }
            };
            viz();

            processor.onaudioprocess = (e) => {
              const data = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(data.length);
              for (let i = 0; i < data.length; i++) int16[i] = data[i] * 32768;
              
              // Ensure we don't send if session closed
              sessionPromise.then(s => {
                  try {
                    s.sendRealtimeInput({ media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } });
                  } catch(e) { /* ignore send errors on close */ }
              }).catch(() => {});
            };
            source.connect(processor);
            processor.connect(inCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              liveTurnIds.current = { user: null, assistant: null };
              return;
            }

            if (msg.serverContent?.inputTranscription) {
              const text = msg.serverContent.inputTranscription.text;
              if (text) {
                setMessages(prev => {
                  const id = liveTurnIds.current.user;
                  if (id) {
                    return prev.map(m => m.id === id ? { ...m, content: m.content + text } : m);
                  } else {
                    const newId = Date.now().toString();
                    liveTurnIds.current.user = newId;
                    return [...prev, { id: newId, role: 'user', content: text }];
                  }
                });
              }
            }

            if (msg.serverContent?.outputTranscription) {
              const text = msg.serverContent.outputTranscription.text;
              if (text) {
                 setMessages(prev => {
                  const id = liveTurnIds.current.assistant;
                  if (id) {
                    return prev.map(m => m.id === id ? { ...m, content: m.content + text } : m);
                  } else {
                    const newId = (Date.now() + 1).toString();
                    liveTurnIds.current.assistant = newId;
                    return [...prev, { id: newId, role: 'assistant', content: text }];
                  }
                });
              }
            }

            if (msg.serverContent?.turnComplete) {
               liveTurnIds.current = { user: null, assistant: null };
            }

            const base64 = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64 && outCtx) {
              try {
                const buffer = await decodeAudioData(decode(base64), outCtx, 24000, 1);
                const source = outCtx.createBufferSource();
                source.buffer = buffer;
                source.connect(outCtx.destination);
                const now = outCtx.currentTime;
                // Schedule next chunk
                if (nextStartTimeRef.current < now) {
                    nextStartTimeRef.current = now + 0.05; // Small buffer
                }
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += buffer.duration;
                
                source.onended = () => {
                    audioSourcesRef.current.delete(source);
                };
                audioSourcesRef.current.add(source);
              } catch (e) { console.error("Audio Decode Error", e); }
            }
          },
          onclose: () => {
              setIsLiveActive(false);
          },
          onerror: (e) => { 
              console.error("Live Error", e); 
              stopLiveSession(); 
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          systemInstruction: `You are CivicEase AI, a dedicated government assistant for India.
          Target Language: ${currentLangNative}.
          Speak ONLY in ${currentLangNative} unless acting as a translator.
          Be concise.
          If asked for directions or offices, mention that you can see the results on the screen.`
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (err) {
      console.error(err);
      setLoading(false);
      showError(t('micError'));
    }
  };

  const stopLiveSession = () => {
    if (liveSessionRef.current) { 
        try { liveSessionRef.current.close(); } catch(e) {} 
        liveSessionRef.current = null;
    }
    
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
    }
    
    audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    
    const { in: inCtx, out: outCtx } = audioContextsRef.current;
    if (inCtx) { try { inCtx.close(); } catch(e) {} }
    if (outCtx) { try { outCtx.close(); } catch(e) {} }
    audioContextsRef.current = { in: null, out: null };

    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    
    setIsLiveActive(false);
    setVoiceVolume(0);
    setLoading(false);
    nextStartTimeRef.current = 0;
    liveTurnIds.current = { user: null, assistant: null };
  };

  const handleSend = async (txt?: string) => {
    const val = txt || input.trim();
    if (!val || loading) return;

    const userMsgId = Date.now().toString();
    const assistantMsgId = (Date.now() + 1).toString();

    setMessages(prev => [...prev, { id: userMsgId, role: 'user', content: val }]);
    setInput('');
    setLoading(true);
    // Reset processed tags for new generation
    processedTagsRef.current.clear();

    try {
      if (initialMode === Mode.OFFICE_LOCATOR && userLocation) {
        const result = await findNearbyOffices(val, userLocation.lat, userLocation.lng, language);
        setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant', content: result.text, groundingLinks: result.grounding }]);
      } else if (initialMode === Mode.SCHEME_FINDER) {
        const result = await findGovSchemes(val, language);
        setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant', content: result.text, groundingLinks: result.grounding }]);
      } else {
        const apiKey = getApiKey();
        if (!apiKey) throw new Error("API Key Missing");
        const ai = new GoogleGenAI({ apiKey });
        
        let systemInstr = `You are CivicEase AI. TARGET LANGUAGE: ${currentLangNative}.
        RULES: 
        1. Reply in ${currentLangNative}.
        2. Keep formatting clean.`;

        if (initialMode === Mode.FORM_FILLING && formState) {
            systemInstr += `\n\nFORM MODE: User edits "${formState.title}". Current fields: ${formState.fields.map(f => f.name).join(', ')}. If user provides value, append [[UPDATE:FieldName:Value]].`;
        }

        const streamResponse = await ai.models.generateContentStream({
          model: 'gemini-3-pro-preview',
          contents: val,
          config: { 
            systemInstruction: systemInstr,
            tools: [{ googleSearch: {} }]
          }
        });

        let fullText = "";
        let groundings: any[] = [];
        setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant', content: "..." }]);

        for await (const chunk of streamResponse) {
            const part = chunk as GenerateContentResponse;
            const text = part.text || "";
            fullText += text;

            if (part.candidates?.[0]?.groundingMetadata?.groundingChunks) {
                const chunks = part.candidates[0].groundingMetadata.groundingChunks;
                const newLinks = chunks.map((c: any) => ({
                    title: c.web?.title || 'Source',
                    uri: c.web?.uri
                })).filter((c: any) => c.uri);
                groundings = [...groundings, ...newLinks];
            }

            let visibleText = fullText;
            const updateRegex = /\[\[UPDATE:(.*?):(.*?)\]\]/g;
            let match;
            
            // Loop through all matches in the accumulated text
            while ((match = updateRegex.exec(fullText)) !== null) {
                const fullMatch = match[0];
                const fieldName = match[1].trim();
                const fieldValue = match[2].trim();
                
                // Only process this specific tag instance if we haven't seen it yet
                const matchUniqueId = `${fieldName}:${fieldValue}`;
                
                if (!processedTagsRef.current.has(matchUniqueId)) {
                    processedTagsRef.current.add(matchUniqueId);
                    
                    setFormState(prev => {
                        if (!prev) return null;
                        const exists = prev.fields.some(f => f.name.toLowerCase().includes(fieldName.toLowerCase()) || fieldName.toLowerCase().includes(f.name.toLowerCase()));
                        if (!exists) return prev;

                        return {
                            ...prev,
                            fields: prev.fields.map(f => {
                                const isMatch = f.name.toLowerCase().includes(fieldName.toLowerCase()) || fieldName.toLowerCase().includes(f.name.toLowerCase());
                                if (isMatch && f.value !== fieldValue) {
                                    return { ...f, value: fieldValue };
                                }
                                return f;
                            })
                        };
                    });
                }
                visibleText = visibleText.replace(fullMatch, '');
            }

            setMessages(prev => prev.map(m => m.id === assistantMsgId ? { 
                ...m, 
                content: visibleText,
                groundingLinks: groundings.length > 0 ? groundings : m.groundingLinks
            } : m));
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant', content: t('errorOccurred') }]);
    } finally {
      setLoading(false);
    }
  };

  const startCamera = async () => {
    setIsCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } 
      });
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (err) {
      showError(t('cameraError'));
      setIsCameraOpen(false);
    }
  };

  const takePhoto = async () => {
    if (!videoRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    canvas.getContext('2d')?.drawImage(videoRef.current, 0, 0);
    const data = canvas.toDataURL('image/jpeg', 0.8);
    
    if (!isLiveActive && videoRef.current.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
        setIsCameraOpen(false);
    }

    setLoading(true);
    try {
      const raw = data.split(',')[1];
      let analysis;
      if (initialMode === Mode.FORM_FILLING) {
        analysis = await analyzeFormImage(raw, language);
        if (!analysis.requiredFields || analysis.requiredFields.length === 0) {
            showError("Could not identify form.");
            setLoading(false);
            return;
        }
        setMessages(prev => [...prev, { id: 'img', role: 'user', content: 'Form Image.', image: data }]);
        setMessages(prev => [...prev, { id: 'resp', role: 'assistant', content: t('formIdentified', { formType: analysis.formType, field: analysis.requiredFields[0] }) }]);
        setFormState({ title: analysis.formType, isCollapsed: false, fields: analysis.requiredFields.map(f => ({ name: f, value: '', section: 'Details' })) });
      } else if (initialMode === Mode.PROBLEM_REPORTING) {
        analysis = await analyzeProblemImage(raw, language);
        setMessages(prev => [...prev, { id: 'img', role: 'user', content: 'Issue Photo.', image: data }]);
        setMessages(prev => [...prev, { id: 'resp', role: 'assistant', content: t('problemIdentified', { problemType: analysis.problemType, severity: analysis.severity, question: analysis.clarifyingQuestions[0] }) }]);
      }
    } catch (e) {
      setMessages(prev => [...prev, { id: 'err', role: 'assistant', content: t('analysisFailed') }]);
    } finally {
      setLoading(false);
    }
  };

  const completedCount = formState?.fields.filter(f => f.value).length || 0;
  const totalCount = formState?.fields.length || 0;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 rounded-[2.5rem] shadow-2xl overflow-hidden relative border border-gray-100 dark:border-white/5 mx-auto max-w-6xl animate-page-enter">
      
      {/* Toast */}
      {errorToast && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 bg-red-500 text-white px-6 py-3 rounded-full shadow-2xl z-[150] flex items-center gap-3 animate-in fade-in slide-in-from-top-4 font-bold text-xs uppercase tracking-wider">
          <i className="fas fa-exclamation-triangle"></i>
          <span>{errorToast}</span>
        </div>
      )}

      {loading && !isLiveActive && (
          <div className="absolute inset-0 z-[100] bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm flex flex-col items-center justify-center animate-in fade-in">
              <div className="flex gap-2 mb-6">
                 {[0, 0.1, 0.2].map(d => <div key={d} className="w-3 h-12 bg-gradient-to-t from-secondary to-orange-400 rounded-full animate-wave" style={{ animationDelay: `${d}s` }}></div>)}
              </div>
              <p className="text-xs font-black uppercase tracking-[0.3em] text-primary dark:text-white">{t('processing')}</p>
          </div>
      )}
      
      {isCameraOpen && (
          <div className="absolute inset-0 z-[110] bg-black flex flex-col">
              <video ref={videoRef} autoPlay playsInline className="flex-1 object-cover"></video>
              <div className="p-10 flex justify-center gap-12 bg-black/50 backdrop-blur-md pb-[calc(2rem+env(safe-area-inset-bottom))]">
                  <button onClick={() => setIsCameraOpen(false)} className="w-16 h-16 rounded-full bg-white/20 text-white hover:bg-white/30 transition-all"><i className="fas fa-times text-xl"></i></button>
                  <button onClick={takePhoto} className="w-20 h-20 rounded-full border-4 border-white flex items-center justify-center transition-all active:scale-95 shadow-[0_0_30px_rgba(255,255,255,0.3)]"><div className="w-16 h-16 rounded-full bg-white"></div></button>
              </div>
          </div>
      )}

      {/* Header */}
      <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-md p-4 md:px-8 flex justify-between items-center z-10 shrink-0 border-b border-gray-100 dark:border-white/5">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-secondary to-orange-500 flex items-center justify-center text-white shadow-lg shadow-orange-500/20"><i className="fas fa-robot text-lg"></i></div>
          <div>
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Active Intelligence • {currentLangNative}</p>
              <h4 className="font-black text-lg md:text-xl text-primary dark:text-white tracking-tight">{t(initialMode.toLowerCase().replace('_', '') + 'Assistant')}</h4>
          </div>
        </div>
        <button onClick={onReset} className="px-5 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
            {t('endSession')}
        </button>
      </div>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        
        {/* Split Screen: Live Visualization Panel */}
        {isLiveActive && (
          <div className="w-full h-[40%] md:w-[40%] md:h-full bg-slate-900 flex flex-col items-center justify-center relative border-b md:border-b-0 md:border-r border-white/10 order-1 md:order-1 transition-all duration-300">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-800 via-slate-900 to-black z-0"></div>
              
              {/* Dynamic Visualizer - Scaled down slightly for split screen */}
              <div className="relative z-10 w-full max-w-[200px] aspect-square flex items-center justify-center scale-75 md:scale-90">
                   <div className="absolute w-56 h-56 border-2 border-secondary/20 rounded-full animate-[spin_10s_linear_infinite]"></div>
                   <div className="absolute w-44 h-44 border-2 border-secondary/10 rounded-full animate-[spin_8s_linear_infinite_reverse]"></div>
                   
                   <div className="absolute inset-0 flex items-center justify-center">
                       <div className="w-32 h-32 bg-secondary/30 rounded-full blur-3xl transition-transform duration-75" style={{ transform: `scale(${1 + voiceVolume/30})` }}></div>
                   </div>
                   
                   <div className="relative z-10 w-24 h-24 bg-gradient-to-tr from-secondary to-orange-500 rounded-full flex items-center justify-center shadow-[0_0_60px_rgba(245,158,11,0.4)] transition-transform duration-75" style={{ transform: `scale(${1 + voiceVolume/100})` }}>
                       <i className="fas fa-microphone text-3xl text-white"></i>
                   </div>
              </div>

              <div className="relative z-10 text-center mt-4">
                  <h3 className="text-white font-black text-xl mb-1 tracking-tight">Listening...</h3>
                  <p className="text-slate-400 text-[10px] font-bold uppercase tracking-widest mb-6">{currentLangNative}</p>
                  
                  <button onClick={stopLiveSession} className="px-6 py-2 rounded-full bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white transition-all flex items-center gap-2 border border-red-500/50 mx-auto text-xs font-bold uppercase tracking-wider">
                    <i className="fas fa-stop"></i> Stop
                  </button>
              </div>
          </div>
        )}

        {/* Chat Area - Occupies remaining space */}
        <div className={`flex-1 overflow-hidden relative flex flex-col bg-slate-50/50 dark:bg-slate-900/50 order-2 md:order-2`}>
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8 scroll-smooth pb-24">
            {messages.map((m, idx) => (
              <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-4 group`}>
                 
                 <div className="flex items-end gap-3 max-w-[95%] md:max-w-[85%]">
                    {m.role === 'assistant' && (
                        <div className="w-8 h-8 rounded-full bg-white dark:bg-slate-800 border border-gray-100 dark:border-white/10 flex items-center justify-center shrink-0 shadow-sm text-secondary text-xs">
                            <i className="fas fa-robot"></i>
                        </div>
                    )}
                    
                    <div className={`p-4 md:p-6 shadow-sm relative ${m.role === 'user' ? 'bubble-user' : 'bubble-assistant'}`}>
                        {m.image && (
                            <div className="mb-4 overflow-hidden rounded-xl border border-white/10 shadow-lg">
                                <img src={m.image} className="w-full object-cover max-h-64" alt="Shared" />
                            </div>
                        )}
                        <p className="text-sm md:text-base font-medium leading-relaxed whitespace-pre-wrap">{m.content}</p>
                        
                        {/* Links / Directions */}
                        {m.groundingLinks && m.groundingLinks.length > 0 && (
                            <div className="mt-4 flex flex-col gap-2 pt-3 border-t border-black/5 dark:border-white/5">
                                {m.groundingLinks.slice(0, 3).map((link, idx) => {
                                  const isMap = link.uri.includes('google.com/maps');
                                  return (
                                    <a key={idx} href={link.uri} target="_blank" rel="noopener noreferrer" 
                                        className={`flex items-center gap-3 p-3 rounded-xl text-xs transition-all border group/link ${isMap ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30' : 'bg-slate-50 dark:bg-slate-800/50 border-gray-100 dark:border-white/5 hover:bg-slate-100'}`}>
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shadow-sm shrink-0 ${isMap ? 'bg-blue-500 text-white' : 'bg-white dark:bg-slate-700 text-slate-500'}`}>
                                            <i className={`fas ${isMap ? 'fa-directions' : 'fa-globe'}`}></i>
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className={`font-bold truncate ${isMap ? 'text-blue-700 dark:text-blue-300' : 'text-slate-700 dark:text-slate-200'}`}>{link.title}</span>
                                            {isMap && <span className="text-[10px] opacity-70 font-semibold uppercase tracking-wide">Get Directions</span>}
                                        </div>
                                        <i className="fas fa-external-link-alt ml-auto opacity-50 text-[10px]"></i>
                                    </a>
                                  );
                                })}
                            </div>
                        )}
                    </div>
                 </div>
                 <span className="text-[10px] font-bold text-slate-300 mt-2 px-1 opacity-0 group-hover:opacity-100 transition-opacity">
                     {m.role === 'user' ? 'You' : 'CivicEase'}
                 </span>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          
          {/* Floating Input Area (Hidden when Live is active for cleaner look, user speaks instead) */}
          {!isLiveActive && (
             <div className="absolute bottom-6 left-4 right-4 md:left-8 md:right-8 z-20">
                 <div className="glass-card p-2 rounded-[1.5rem] flex items-center gap-2 shadow-xl shadow-slate-200/50 dark:shadow-black/50">
                    <button onClick={startCamera} className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-300 transition-colors flex items-center justify-center">
                        <i className="fas fa-camera"></i>
                    </button>
                    
                    <button onClick={toggleLiveVoice} className="w-12 h-12 rounded-full bg-secondary/10 hover:bg-secondary/20 text-secondary transition-colors flex items-center justify-center relative overflow-hidden group">
                        <div className="absolute inset-0 bg-secondary/20 rounded-full animate-ping opacity-0 group-hover:opacity-100"></div>
                        <i className="fas fa-microphone relative z-10"></i>
                    </button>
                    
                    <div className="h-8 w-px bg-slate-200 dark:bg-slate-700 mx-1"></div>
                    
                    <input 
                        type="text" 
                        value={input} 
                        onChange={e => setInput(e.target.value)} 
                        onKeyDown={e => e.key === 'Enter' && handleSend()} 
                        className="flex-1 bg-transparent border-none outline-none text-sm md:text-base font-medium px-2 text-slate-800 dark:text-white placeholder:text-slate-400"
                        placeholder={t('speakOrType')}
                    />
                    
                    <button 
                        onClick={() => handleSend()} 
                        disabled={!input.trim()} 
                        className="w-12 h-12 rounded-full bg-primary hover:bg-slate-800 text-white shadow-lg disabled:opacity-50 disabled:shadow-none transition-all flex items-center justify-center transform active:scale-90"
                    >
                        <i className="fas fa-arrow-up"></i>
                    </button>
                 </div>
             </div>
          )}
        </div>

        {/* Sidebar for Forms */}
        {formState && (
          <div className={`shrink-0 transition-all duration-500 bg-white dark:bg-slate-900 border-l border-gray-100 dark:border-white/5 flex flex-col shadow-2xl z-30 ${formState.isCollapsed ? 'md:w-16 w-14' : 'md:w-80 w-full h-[35dvh] md:h-auto absolute bottom-0 left-0 right-0 md:relative order-3'}`}>
             {/* ... Sidebar content ... */}
             <div className="p-4 border-b border-gray-100 dark:border-white/5 flex items-center justify-between shrink-0 bg-slate-50/50 dark:bg-slate-800/50">
                <div className={`transition-opacity duration-300 ${formState.isCollapsed ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100'}`}>
                    <h5 className="text-[9px] font-black uppercase tracking-widest text-secondary mb-1">Form Progress</h5>
                    <h4 className="text-sm font-bold truncate max-w-[180px]">{formState.title}</h4>
                </div>
                <button onClick={() => setFormState(prev => prev ? { ...prev, isCollapsed: !prev.isCollapsed } : prev)} className="w-8 h-8 rounded-lg bg-white dark:bg-slate-700 flex items-center justify-center text-slate-400 shadow-sm hover:text-primary transition-colors">
                    <i className={`fas ${formState.isCollapsed ? 'fa-chevron-left' : 'fa-chevron-down md:fa-chevron-right'} text-xs`}></i>
                </button>
             </div>
             
             {!formState.isCollapsed && (
                 <div className="flex-1 overflow-y-auto p-5 space-y-6">
                     <div className="space-y-2">
                         <div className="flex justify-between items-end">
                             <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Completion</span>
                             <span className="text-sm font-black text-primary dark:text-white">{Math.round(progressPercent)}%</span>
                         </div>
                         <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                             <div className="h-full bg-gradient-to-r from-secondary to-orange-500 transition-all duration-700 ease-out" style={{ width: `${progressPercent}%` }}></div>
                         </div>
                     </div>
                     
                     <div className="space-y-3">
                        {formState.fields.map((f, i) => (
                            <div key={i} className={`p-3 rounded-xl border transition-all ${f.value ? 'bg-green-50/50 dark:bg-green-900/10 border-green-200 dark:border-green-800' : 'bg-white dark:bg-slate-800 border-gray-100 dark:border-white/5'}`}>
                                <div className="flex justify-between items-start gap-2">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{f.name}</span>
                                    {f.value ? <i className="fas fa-check-circle text-green-500 text-xs"></i> : <div className="w-2 h-2 rounded-full bg-slate-200 dark:bg-slate-700"></div>}
                                </div>
                                <div className={`mt-1 text-xs font-semibold truncate ${f.value ? 'text-slate-800 dark:text-slate-200' : 'text-slate-300 italic'}`}>
                                    {f.value || 'Required'}
                                </div>
                            </div>
                        ))}
                     </div>
                     
                     {progressPercent === 100 && (
                         <button onClick={onComplete} className="w-full py-4 bg-primary text-white rounded-xl font-black uppercase tracking-widest text-xs shadow-xl active:scale-95 transition-all">
                             Submit Application
                         </button>
                     )}
                 </div>
             )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatWindow;