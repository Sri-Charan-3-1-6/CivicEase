
import { GoogleGenAI, Type } from "@google/genai";
import { FormAnalysis, ProblemAnalysis, Language, VaultDoc, LANGUAGES } from "../types";

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

// Helper to get full language name for stricter prompt adherence
const getLangName = (code: Language) => LANGUAGES.find(l => l.code === code)?.name || 'English';

// Helper to clean JSON string from Markdown code fences and extract valid JSON object
const cleanJSON = (text: string) => {
  if (!text) return '{}';
  // Remove markdown code blocks
  let cleaned = text.replace(/```json\s*|\s*```/g, '').replace(/```/g, '').trim();
  // Attempt to find the first '{' and last '}' to extract the actual JSON object
  // This handles cases where the model might add conversational text before/after the JSON
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.substring(start, end + 1);
  }
  return cleaned;
};

export const analyzeFormImage = async (base64Image: string, language: Language = 'en'): Promise<FormAnalysis> => {
  const ai = getAI();
  const langName = getLangName(language);
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: {
      parts: [
        { inlineData: { data: base64Image, mimeType: 'image/jpeg' } },
        { text: `Analyze this Indian government form. Identify the exact form name/type and list all data fields needed. Suggest specific attachments. CRITICAL: All user-facing descriptions and labels in the JSON output MUST be in ${langName}.` }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          formType: { type: Type.STRING, description: `Name of the form in ${langName}` },
          requiredFields: { type: Type.ARRAY, items: { type: Type.STRING }, description: `List of fields in ${langName}` },
          suggestedDocs: { type: Type.ARRAY, items: { type: Type.STRING }, description: `List of attachments in ${langName}` }
        },
        required: ["formType", "requiredFields", "suggestedDocs"]
      }
    }
  });
  return JSON.parse(cleanJSON(response.text || '{}'));
};

export const analyzeProblemImage = async (base64Image: string, language: Language = 'en'): Promise<ProblemAnalysis> => {
  const ai = getAI();
  const langName = getLangName(language);
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: {
      parts: [
        { inlineData: { data: base64Image, mimeType: 'image/jpeg' } },
        { text: `Analyze this civic problem photo (Indian context). Identify type (pothole, garbage, etc.), severity, and 2-3 clarifying questions. CRITICAL: All text values in the JSON output MUST be in ${langName}.` }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          problemType: { type: Type.STRING, description: `Problem type in ${langName}` },
          severity: { type: Type.STRING, enum: ['low', 'medium', 'high', 'urgent'] },
          clarifyingQuestions: { type: Type.ARRAY, items: { type: Type.STRING }, description: `Questions for user in ${langName}` }
        },
        required: ["problemType", "severity", "clarifyingQuestions"]
      }
    }
  });
  return JSON.parse(cleanJSON(response.text || '{}'));
};

export const suggestVaultPreFill = async (assistantText: string, vaultDocs: VaultDoc[], language: Language = 'en'): Promise<{ docType: string; value: string } | null> => {
  const fetchedDocs = vaultDocs.filter(d => d.status === 'FETCHED' && d.data);
  if (fetchedDocs.length === 0) return null;
  
  const langName = getLangName(language);
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `The assistant just said: "${assistantText}". 
    The user has these DigiLocker documents fetched: ${JSON.stringify(fetchedDocs)}. 
    Does the assistant's request match a piece of information available in these documents? 
    Example: Assistant asks for "Full Name" and Aadhaar has "Name". Assistant asks for "Aadhaar number" and Aadhaar has "DocumentID".
    CRITICAL: Return the JSON output with values appropriate for a conversation in ${langName}.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          docType: { type: Type.STRING, description: `Name of the document source in ${langName}` },
          value: { type: Type.STRING, description: `The actual value to pre-fill` }
        }
      }
    }
  });

  try {
    const text = cleanJSON(response.text || '');
    if (text === 'null' || text.includes('null')) return null;
    const result = JSON.parse(text);
    return result.value ? result : null;
  } catch {
    return null;
  }
};

export const findNearbyOffices = async (query: string, lat: number, lng: number, language: Language = 'en'): Promise<{ text: string; grounding?: any[] }> => {
  const ai = getAI();
  const langName = getLangName(language);
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Locate the ABSOLUTE NEAREST and active government office for "${query}" near these Indian GPS coordinates: Latitude ${lat}, Longitude ${lng}. 
    Consider all Indian administrative levels: Rural/Tehsil, District, Municipal.
    Provide the exact name, a very short address, and distance. 
    CRITICAL: Respond strictly in ${langName}. If the place name is in English, transliterate or translate it to ${langName}.`,
    config: {
      tools: [{ googleMaps: {} }],
      toolConfig: { retrievalConfig: { latLng: { latitude: lat, longitude: lng } } }
    },
  });
  
  const grounding = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map((chunk: any) => ({
    title: chunk.maps?.title || 'Gov Location', 
    uri: chunk.maps?.uri
  })).filter((c: any) => c.uri) || [];
  
  return { text: response.text || '', grounding };
};

export const findGovSchemes = async (profile: string, language: Language = 'en'): Promise<{ text: string; grounding?: any[] }> => {
  const ai = getAI();
  const langName = getLangName(language);
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Identify top 3 Indian govt schemes for: ${profile}. List eligibility. 
    CRITICAL: Provide all information strictly in ${langName}. If scheme names are in English, provide them in ${langName} as well.`,
    config: { tools: [{ googleSearch: {} }] }
  });
  const grounding = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map((chunk: any) => ({
    title: chunk.web?.title || 'Gov Source', 
    uri: chunk.web?.uri
  })).filter((c: any) => !!c.uri) || [];
  return { text: response.text || '', grounding };
};

export const simulateDigiLockerFetch = async (docType: string): Promise<Record<string, string>> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Act as the DigiLocker API. Generate a realistic JSON object for an Indian "${docType}".
    - For AADHAAR: Include Name, DOB, Gender, Aadhaar Number (format: XXXX XXXX XXXX), VID, and Address.
    - For PAN: Include Name, Father's Name, DOB, PAN Number (format: ABCDE1234F), and Category.
    - For DL: Include Name, S/O or D/O, License Number, Valid Until, and Vehicle Class.
    - For VOTER_ID: Include EPIC Number, Name, Relation Name, and Assembly Constituency.
    - For RATION_CARD: Include Card Number, Family Head, Address, and FPS Name.
    - For COVID_CERT: Include Beneficiary ID, Name, Vaccine Name (Covishield/Covaxin), Dose 1 Date, Dose 2 Date, and Status (Fully Vaccinated).
    - For CLASS_X_MARK: Include Candidate Name, Roll Number, Year of Passing, Board Name (CBSE/State), CGPA/Percentage, and School Name.
    Use realistic Indian names and addresses. Ensure valid formatting.`,
    config: { responseMimeType: "application/json" }
  });
  return JSON.parse(cleanJSON(response.text || '{}'));
};
