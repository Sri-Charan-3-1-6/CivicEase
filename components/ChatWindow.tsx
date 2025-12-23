
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const liveSessionRef = useRef<any>(null);
  const audioContextsRef = useRef<{ out: AudioContext | null, in: AudioContext | null }>({ out: null, in: null });
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<any>(null);

  // Track current turn message IDs for Live API streaming
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

  useEffect(() => {
    if (messages.length === 0) {
      const modeName = t(initialMode.toLowerCase().replace('_', '') + 'Assistant') || t('assistant');
      setMessages([{ id: 'init', role: 'assistant', content: t('welcomeMessage', { mode: modeName }) }]);
    }
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
    if (onMessagesChange) onMessagesChange(messages);
  }, [messages]);

  useEffect(() => {
    return () => { stopLiveSession(); };
  }, []);

  // Hot-reloading AI context when language changes
  useEffect(() => {
    if (isLiveActive) {
      stopLiveSession();
      // Small delay to allow cleanup
      setTimeout(() => toggleLiveVoice(), 500);
    }
  }, [language]);

  // Live Vision: Stream frames if Live is active AND Camera is open
  useEffect(() => {
    if (isLiveActive && isCameraOpen && videoRef.current && liveSessionRef.current) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        frameIntervalRef.current = setInterval(async () => {
            if (videoRef.current && ctx) {
                canvas.width = videoRef.current.videoWidth / 3; // Lower res for latency
                canvas.height = videoRef.current.videoHeight / 3;
                ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
                // 0.5 quality jpeg
                const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
                
                // IMPORTANT: Use session promise to prevent stale closure if we were using it, 
                // but here we use the ref which is stable.
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
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      await outCtx.resume();
      await inCtx.resume();
      audioContextsRef.current = { out: outCtx, in: inCtx };

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 16000 } 
      });
      streamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
              setVoiceVolume(data.reduce((a, b) => a + b) / data.length);
              requestAnimationFrame(viz);
            };
            viz();

            processor.onaudioprocess = (e) => {
              const data = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(data.length);
              for (let i = 0; i < data.length; i++) int16[i] = data[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } }))
                .catch(() => {});
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

            // Handle Input Transcription (User Speech)
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

            // Handle Output Transcription (Model Speech)
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
              const buffer = await decodeAudioData(decode(base64), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outCtx.destination);
              // Optimistic scheduling to reduce latency
              const now = outCtx.currentTime;
              // If next start time is in the past, reset it to now (plus small buffer)
              if (nextStartTimeRef.current < now) {
                  nextStartTimeRef.current = now + 0.05;
              }
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              audioSourcesRef.current.add(source);
            }
          },
          onclose: () => setIsLiveActive(false),
          onerror: (e) => { console.error("Live Error", e); stopLiveSession(); }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          // Enable transcriptions to visualize the conversation
          // IMPORTANT: Do NOT pass a model name here. Just enable them.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          systemInstruction: `You are CivicEase AI, a dedicated government assistant for India.
          
          CRITICAL LANGUAGE RULE: 
          The user has selected: ${currentLangName} (${currentLangNative}).
          1. YOU MUST SPEAK, THINK, AND RESPOND IN ${currentLangNative}.
          2. IF THE USER SPEAKS ENGLISH, MENTALLY TRANSLATE IT AND REPLY IN ${currentLangNative}.
          
          INTELLIGENT DATA HANDLING (FORM FILLING EXCEPTION):
          - If the user provides specific DATA VALUES (like Name, ID numbers, addresses, vehicle numbers) that are officially written in English/Latin script:
            - DO NOT TRANSLATE THE VALUE itself into the native script unless explicitly asked.
            - KEEP THE DATA VALUE IN ENGLISH.
          - Example: User says "My name is Rahul Sharma".
            - Hindi Response: "ठीक है, मैंने आपका नाम 'Rahul Sharma' अपडेट कर दिया है।" (Notice 'Rahul Sharma' is kept in English script).
            - Reason: Official Indian forms often require English data entry.
          
          ROLE & BEHAVIOR:
          - Helper for: ${initialMode}.
          - Tone: Professional, warm, clear.
          - Context: User is likely in India, coordinates: ${userLocation?.lat}, ${userLocation?.lng}.
          - Keep answers concise for voice interaction.`
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (err) {
      console.error(err);
      setLoading(false);
      alert(t('micError'));
    }
  };

  const stopLiveSession = () => {
    if (liveSessionRef.current) { try { liveSessionRef.current.close(); } catch(e) {} }
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    
    // Check state before closing to avoid "Cannot close a closed AudioContext" error
    if (audioContextsRef.current.in && audioContextsRef.current.in.state !== 'closed') {
      try { audioContextsRef.current.in.close(); } catch(e) {}
    }
    if (audioContextsRef.current.out && audioContextsRef.current.out.state !== 'closed') {
      try { audioContextsRef.current.out.close(); } catch(e) {}
    }

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

    try {
      if (initialMode === Mode.OFFICE_LOCATOR && userLocation) {
        const result = await findNearbyOffices(val, userLocation.lat, userLocation.lng, language);
        setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant', content: result.text, groundingLinks: result.grounding }]);
      } else if (initialMode === Mode.SCHEME_FINDER) {
        const result = await findGovSchemes(val, language);
        setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant', content: result.text, groundingLinks: result.grounding }]);
      } else {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        let systemInstr = `You are CivicEase AI. TARGET LANGUAGE: ${currentLangNative}.
        
        STRICT OUTPUT RULES:
        1. PROVIDE ALL CONVERSATIONAL RESPONSES EXCLUSIVELY IN ${currentLangNative}.
        2. Act as a real-time translator if the user uses multiple languages.
        
        INTELLIGENT FORM FILLING EXCEPTION:
        - If the user is providing specific VALUES for a form (like Name: 'Amit', ID: 'ABC1234'), keep those values in the script they were provided (usually English) if that matches the form's requirement.
        - DO NOT translate the *content* of the data unless it makes sense (e.g. translate 'Village' to 'गाँव' is okay, but 'Aadhaar ID' characters should remain).
        - Example: If user says "My name is John", reply in ${currentLangNative}: "Sure, I have updated your name to John." (Keep 'John' in English if form is English).
        
        Context: ${initialMode}. Be helpful and professional.
        Use Google Search to provide up-to-date info if needed.`;

        if (initialMode === Mode.FORM_FILLING && formState) {
            systemInstr += `\n\nFORM EDITING MODE:
            The user might want to fill fields for the form: "${formState.title}".
            Current fields: ${formState.fields.map(f => f.name).join(', ')}.
            If the user provides a value for a field, output a HIDDEN tag at the end of your response like this:
            [[UPDATE:FieldName:Value]]
            Example: "Sure, I've updated your name." [[UPDATE:Full Name:John Doe]]`;
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
            // Extract text
            const text = part.text || "";
            fullText += text;

            // Extract grounding
            if (part.candidates?.[0]?.groundingMetadata?.groundingChunks) {
                const chunks = part.candidates[0].groundingMetadata.groundingChunks;
                const newLinks = chunks.map((c: any) => ({
                    title: c.web?.title || 'Source',
                    uri: c.web?.uri
                })).filter((c: any) => c.uri);
                groundings = [...groundings, ...newLinks];
            }

            // Parse update tags (remove from visible text)
            let visibleText = fullText;
            const updateRegex = /\[\[UPDATE:(.*?):(.*?)\]\]/g;
            let match;
            while ((match = updateRegex.exec(fullText)) !== null) {
                const fieldName = match[1].trim();
                const fieldValue = match[2].trim();
                // Update form state
                setFormState(prev => {
                    if (!prev) return null;
                    return {
                        ...prev,
                        fields: prev.fields.map(f => f.name.toLowerCase().includes(fieldName.toLowerCase()) || fieldName.toLowerCase().includes(f.name.toLowerCase()) 
                            ? { ...f, value: fieldValue } 
                            : f)
                    };
                });
                visibleText = visibleText.replace(match[0], '');
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
      alert(t('cameraError'));
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
    
    // Do NOT stop tracks if Live is active, only if just taking a photo
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
    <div className="flex flex-col h-[85dvh] md:h-[75vh] bg-white dark:bg-slate-900 md:rounded-[3rem] shadow-2xl overflow-hidden relative border border-gray-100 dark:border-white/5 mx-[-1rem] md:mx-0">
      {loading && !isLiveActive && <div className="absolute inset-0 z-[100] bg-white/60 dark:bg-slate-900/60 backdrop-blur-md flex flex-col items-center justify-center animate-in fade-in"><div className="flex gap-1.5 mb-6">{[0, 0.1, 0.2].map(d => <div key={d} className="w-2 h-8 bg-secondary rounded-full animate-wave" style={{ animationDelay: `${d}s` }}></div>)}</div><p className="text-[10px] font-black uppercase tracking-[0.3em] text-primary dark:text-white">{t('processing')}</p></div>}
      
      {isCameraOpen && <div className="absolute inset-0 z-[110] bg-black flex flex-col"><video ref={videoRef} autoPlay playsInline className="flex-1 object-cover"></video><div className="p-10 flex justify-center gap-10 bg-black pb-[calc(2rem+env(safe-area-inset-bottom))]"><button onClick={() => setIsCameraOpen(false)} className="w-14 h-14 rounded-full bg-white/10 text-white"><i className="fas fa-times"></i></button><button onClick={takePhoto} className="w-20 h-20 rounded-full border-4 border-white flex items-center justify-center transition-all active:scale-90"><div className="w-14 h-14 rounded-full bg-white"></div></button></div></div>}

      <div className="bg-primary dark:bg-slate-950 p-4 md:p-8 flex justify-between items-center z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center text-primary"><i className="fas fa-robot"></i></div>
          <div><p className="text-[7px] font-black text-white/30 uppercase tracking-widest leading-none mb-1">Live Intelligence • {currentLangNative}</p><h4 className="font-black text-xs md:text-xl text-white tracking-tight uppercase truncate">{t(initialMode.toLowerCase().replace('_', '') + 'Assistant')}</h4></div>
        </div>
        <button onClick={onReset} className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-[8px] font-black uppercase text-white tracking-widest hover:bg-white/10">{t('endSession')}</button>
      </div>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden relative">
          <div className="flex-1 overflow-y-auto p-4 md:p-10 space-y-6 bg-[#fcfcfd] dark:bg-slate-900/50">
            {messages.map(m => (
              <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2`}>
                <div className={`max-w-[90%] md:max-w-[75%] p-4 md:p-6 shadow-sm ${m.role === 'user' ? 'bubble-user' : 'bubble-assistant'}`}>
                  {m.image && <img src={m.image} className="rounded-2xl mb-4 w-full object-cover max-h-64 shadow-xl" alt="Shared" />}
                  <p className="text-xs md:text-base font-bold leading-relaxed whitespace-pre-wrap">{m.content}</p>
                  
                  {/* Grounding Links Rendering */}
                  {m.groundingLinks && m.groundingLinks.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-2 pt-3 border-t border-black/5 dark:border-white/5">
                        {m.groundingLinks.slice(0, 3).map((link, idx) => (
                          <a key={idx} href={link.uri} target="_blank" rel="noopener noreferrer" 
                             className="flex items-center gap-2 bg-white/50 dark:bg-black/20 p-2 rounded-lg text-[9px] hover:bg-secondary/10 transition-colors border border-black/5 dark:border-white/5">
                             <i className={`fas ${link.uri.includes('google.com/maps') ? 'fa-map-marker-alt text-red-500' : 'fa-globe text-blue-500'}`}></i>
                             <span className="truncate max-w-[120px] font-medium text-primary dark:text-white opacity-80">{link.title}</span>
                          </a>
                        ))}
                      </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={scrollRef} />
          </div>

          {isLiveActive && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-secondary text-primary px-6 py-2.5 rounded-full shadow-2xl flex items-center gap-3 z-50 animate-in slide-in-from-top-4">
              <div className="flex gap-0.5 items-end h-3">{[0, 1, 2, 3, 4].map(i => <div key={i} className="w-0.5 bg-primary rounded-full transition-all duration-75" style={{ height: `${Math.max(2, voiceVolume / 10)}px` }}></div>)}</div>
              <span className="text-[9px] font-black uppercase tracking-widest">{t('voiceLive')} ({currentLangNative})</span>
              <button onClick={stopLiveSession} className="w-5 h-5 bg-primary/10 rounded-full flex items-center justify-center"><i className="fas fa-times text-[8px]"></i></button>
            </div>
          )}
        </div>

        {formState && (
          <div className={`shrink-0 transition-all duration-500 bg-white dark:bg-slate-900 border-l border-gray-100 dark:border-white/5 flex flex-col ${formState.isCollapsed ? 'md:w-20 w-12' : 'md:w-[350px] w-full h-[40dvh] md:h-auto'}`}>
            <div className="p-4 md:p-6 border-b border-gray-50 dark:border-white/5 flex items-center justify-between shrink-0">
                <div className={`transition-opacity duration-300 ${formState.isCollapsed ? 'opacity-0 overflow-hidden w-0' : 'opacity-100'}`}><h5 className="text-[10px] font-black uppercase tracking-widest text-secondary mb-1">Live Progress</h5><h4 className="text-sm font-black dark:text-white truncate max-w-[200px]">{formState.title}</h4></div>
                <button onClick={() => setFormState(prev => prev ? { ...prev, isCollapsed: !prev.isCollapsed } : prev)} className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-gray-400"><i className={`fas ${formState.isCollapsed ? 'fa-expand' : 'fa-compress'} text-xs`}></i></button>
            </div>
            {!formState.isCollapsed && <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6"><div className="space-y-2"><div className="flex justify-between items-end"><span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Fields Filled</span><span className="text-xs font-black text-secondary">{completedCount}/{totalCount}</span></div><div className="h-2 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden"><div className="h-full bg-secondary transition-all duration-500" style={{ width: `${progressPercent}%` }}></div></div></div>{formState.fields.map(f => (<div key={f.name} className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-gray-50 dark:border-white/5"><div className="flex justify-between items-center"><span className="text-[9px] font-bold text-gray-400 uppercase truncate max-w-[150px]">{f.name}</span>{f.value ? <i className="fas fa-check-circle text-green-500 text-[10px]"></i> : <i className="fas fa-circle-notch text-gray-200 text-[10px]"></i>}</div><span className={`text-[11px] font-bold truncate ${f.value ? 'text-primary dark:text-white' : 'text-gray-300 italic'}`}>{f.value || 'Waiting...'}</span></div>))}{progressPercent === 100 && <button onClick={onComplete} className="w-full bg-green-500 text-white py-4 rounded-2xl font-black uppercase tracking-widest text-xs shadow-xl active:scale-95 transition-all">Submit Final Form</button>}</div>}
          </div>
        )}
      </div>

      <div className="p-4 md:p-8 bg-white dark:bg-slate-900 border-t border-gray-100 dark:border-white/5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <div className="flex gap-2 md:gap-4 max-w-5xl mx-auto">
          <button onClick={startCamera} className="w-12 h-12 md:w-16 md:h-16 bg-slate-50 dark:bg-slate-800 rounded-xl md:rounded-2xl flex items-center justify-center text-primary dark:text-secondary active:scale-95 transition-all"><i className="fas fa-camera text-base md:text-xl"></i></button>
          <button onClick={toggleLiveVoice} className={`w-12 h-12 md:w-16 md:h-16 rounded-xl md:rounded-2xl flex items-center justify-center transition-all ${isLiveActive ? 'bg-secondary text-primary' : 'bg-slate-50 dark:bg-slate-800 text-gray-500'}`}><i className={`fas ${isLiveActive ? 'fa-stop-circle' : 'fa-microphone'} text-base md:text-xl`}></i></button>
          <div className="flex-1 relative"><input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSend()} className="w-full h-12 md:h-16 bg-slate-50 dark:bg-slate-950 rounded-xl md:rounded-2xl px-6 dark:text-white font-bold text-xs md:text-base outline-none border border-transparent focus:border-secondary transition-all" placeholder={t('speakOrType')}/></div>
          <button onClick={() => handleSend()} className="w-12 h-12 md:w-16 md:h-16 bg-primary text-white flex items-center justify-center rounded-xl md:rounded-2xl shrink-0 shadow-lg active:scale-90 transition-all"><i className="fas fa-paper-plane"></i></button>
        </div>
      </div>
    </div>
  );
};

export default ChatWindow;
