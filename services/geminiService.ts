import { GoogleGenAI, Type } from "@google/genai";
import { FormAnalysis, ProblemAnalysis, Language, VaultDoc, LANGUAGES } from "../types";

// Securely retrieve API key: 
// 1. From Android Native Injection (window.API_KEY) - Most Secure for App
// 2. From Environment Variables (process.env.API_KEY) - Secure for Web
const getAI = () => {
  const key = (window as any).API_KEY || process.env.API_KEY;
  if (!key) console.warn("Missing API Key. Ensure it is set in ENV or injected via Android.");
  return new GoogleGenAI({ apiKey: key });
};

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
  try {
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
  } catch (error) {
    console.warn("AI Analysis Failed (Form):", error);
    return { formType: "Analysis Failed", requiredFields: [], suggestedDocs: [] };
  }
};

export const analyzeProblemImage = async (base64Image: string, language: Language = 'en'): Promise<ProblemAnalysis> => {
  const ai = getAI();
  const langName = getLangName(language);
  try {
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
  } catch (error) {
    console.warn("AI Analysis Failed (Problem):", error);
    return { problemType: "Unknown Issue", severity: "low", clarifyingQuestions: [] };
  }
};

export const suggestVaultPreFill = async (assistantText: string, vaultDocs: VaultDoc[], language: Language = 'en'): Promise<{ docType: string; value: string } | null> => {
  const fetchedDocs = vaultDocs.filter(d => d.status === 'FETCHED' && d.data);
  if (fetchedDocs.length === 0) return null;
  
  const langName = getLangName(language);
  const ai = getAI();
  try {
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
  // Improved prompt to ask for multiple options and ensure direction links are prioritized
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Find the top 3 nearest and active government offices relevant to "${query}" near Indian GPS coordinates: Lat ${lat}, Lng ${lng}.
    Consider Tehsildar, District Offices, Municipal Corporations, or Seva Kendras.
    For each option, provide:
    1. The Exact Name
    2. A brief address
    3. Approximate distance
    CRITICAL: Respond strictly in ${langName}. Use the Google Maps tool to verify existence and generate grounding links for directions.`,
    config: {
      tools: [{ googleMaps: {} }],
      toolConfig: { retrievalConfig: { latLng: { latitude: lat, longitude: lng } } }
    },
  });
  
  const grounding = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map((chunk: any) => ({
    title: chunk.maps?.title || 'View on Maps', 
    uri: chunk.maps?.uri
  })).filter((c: any) => c.uri) || [];
  
  return { text: response.text || '', grounding };
};

export const findGovSchemes = async (profile: string, language: Language = 'en'): Promise<{ text: string; grounding?: any[] }> => {
  const ai = getAI();
  const langName = getLangName(language);
  // Upgraded to Gemini 3.0 Pro for comprehensive search and reasoning
  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: `Act as an expert Indian Government Scheme Advisor.
    Perform an extensive search to find ALL relevant and active government schemes for the profile/query: "${profile}".
    
    Do not limit the number of schemes. Include major Central Government schemes and relevant State Government schemes if a location is implied.
    
    For each scheme, strictly provide:
    1. Scheme Name
    2. Key Benefits (Cash assistance, subsidy, insurance coverage, etc.)
    3. Eligibility Criteria (Income limit, Age, Caste, etc.)
    4. Application Mode (Online portal link name or Offline office)
    
    Format the output clearly with bullet points.
    CRITICAL: Provide ALL information strictly in ${langName}.`,
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
  try {
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
  } catch (error) {
    console.error("DigiLocker Sim Failed:", error);
    return {};
  }
};