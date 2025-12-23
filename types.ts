
// @google/genai guidelines followed: defining types for structured application state.
export enum Mode {
  IDLE = 'IDLE',
  FORM_FILLING = 'FORM_FILLING',
  PROBLEM_REPORTING = 'PROBLEM_REPORTING',
  DIGILOCKER = 'DIGILOCKER',
  SCHEME_FINDER = 'SCHEME_FINDER',
  OFFICE_LOCATOR = 'OFFICE_LOCATOR',
  HISTORY = 'HISTORY'
}

export enum Step {
  INITIAL = 'INITIAL',
  UPLOADING = 'UPLOADING',
  ANALYZING = 'ANALYZING',
  CHATTING = 'CHATTING',
  COMPLETED = 'COMPLETED'
}

export type Language = 'en' | 'hi' | 'bn' | 'te' | 'mr' | 'ta' | 'gu' | 'ur' | 'kn' | 'or' | 'ml' | 'pa';

export const LANGUAGES: { code: Language; name: string; native: string }[] = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు' },
  { code: 'mr', name: 'Marathi', native: 'मराठी' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'ur', name: 'Urdu', native: 'اردو' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
];

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image?: string;
  video?: string;
  groundingLinks?: { title: string; uri: string }[];
}

export interface ChatSession {
  id: string;
  mode: Mode;
  language: Language;
  messages: Message[];
  timestamp: string;
  summary: string;
}

export interface VaultDoc {
  id: string;
  name: string;
  type: 'AADHAAR' | 'PAN' | 'DL' | 'VOTER_ID' | 'RATION_CARD' | 'COVID_CERT' | 'CLASS_X_MARK' | 'OTHER';
  status: 'FETCHED' | 'NOT_FETCHED';
  data?: Record<string, string>;
  lastUpdated?: string;
}

export interface FormAnalysis {
  formType: string;
  requiredFields: string[];
  suggestedDocs: string[];
}

export interface ProblemAnalysis {
  problemType: string;
  severity: 'low' | 'medium' | 'high' | 'urgent';
  clarifyingQuestions: string[];
}

export interface Report {
  id: string;
  type: Mode;
  date: string;
  summary: string;
  status: 'Draft' | 'Submitted' | 'Processing';
  documentUrl?: string;
}
