import { GoogleGenAI, Type } from "@google/genai";
import { MASTER_STYLE_PROMPT, SYSTEM_INSTRUCTION_STORY_ANALYSIS } from "../constants";

// Initialize Gemini Client Lazily
let ai: GoogleGenAI | null = null;

export const hasApiKey = (): boolean => {
  return !!process.env.API_KEY;
};

export const getApiKey = (): string | undefined => {
  return process.env.API_KEY;
};

const getAi = (): GoogleGenAI => {
  if (!process.env.API_KEY) {
    throw new Error("API Key가 설정되지 않았습니다. .env 파일을 확인해주세요.");
  }
  if (!ai) {
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  }
  return ai;
};

export interface SceneBlueprint {
  scene_number: number;
  korean_summary: string;
  english_prompt: string;
}

const cleanJson = (text: string): string => {
  let clean = text.trim();
  // Remove markdown code blocks if present
  if (clean.startsWith('```json')) {
    clean = clean.replace(/^```json/, '').replace(/```$/, '');
  } else if (clean.startsWith('```')) {
    clean = clean.replace(/^```/, '').replace(/```$/, '');
  }
  return clean.trim();
};

/**
 * Step 1: Analyzes the script and breaks it down into safety-checked scenes.
 */
export const analyzeScript = async (userInput: string): Promise<SceneBlueprint[]> => {
  try {
    const client = getAi();
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: userInput,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION_STORY_ANALYSIS,
        temperature: 0.7,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              scene_number: { type: Type.INTEGER },
              korean_summary: { type: Type.STRING },
              english_prompt: { type: Type.STRING },
            },
            required: ["scene_number", "korean_summary", "english_prompt"],
          },
        },
      },
    });

    if (response.text) {
      const cleanedText = cleanJson(response.text);
      const parsed = JSON.parse(cleanedText);
      
      // Ensure result is an array
      if (Array.isArray(parsed)) {
        return parsed as SceneBlueprint[];
      } else if (typeof parsed === 'object' && parsed !== null) {
        // Handle edge case where model returns single object instead of array
        return [parsed as SceneBlueprint];
      }
    }
    throw new Error("Empty or invalid response from AI analysis");
  } catch (error) {
    console.error("Error analyzing script:", error);
    // Fallback: If analysis fails, treat the whole input as one scene
    return [{
      scene_number: 1,
      korean_summary: "단일 장면",
      english_prompt: userInput // We might want to run a simple translation here in a real app, but this is a safe fallback
    }];
  }
};

/**
 * Step 2: Generates the image using the refined prompt + master style.
 */
export const generateImage = async (
  sceneDescription: string,
  aspectRatio: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" = "16:9"
): Promise<string> => {
  try {
    const client = getAi();
    // Combine the master style with the specific scene description
    const fullPrompt = `${MASTER_STYLE_PROMPT} ${sceneDescription}`;

    const response = await client.models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: {
        parts: [{ text: fullPrompt }],
      },
      config: {
        imageConfig: {
          aspectRatio: aspectRatio,
          // Gemini 2.5 flash image supports generation count of 1 by default
        }
      },
    });

    // Extract image from response
    let imageUrl = "";
    if (response.candidates && response.candidates[0].content.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const base64Data = part.inlineData.data;
          const mimeType = part.inlineData.mimeType || "image/png";
          imageUrl = `data:${mimeType};base64,${base64Data}`;
          break;
        }
      }
    }

    if (!imageUrl) {
      throw new Error("이미지를 생성하지 못했습니다.");
    }

    return imageUrl;
  } catch (error) {
    console.error("Error generating image:", error);
    throw new Error("이미지 생성 중 오류가 발생했습니다.");
  }
};

/**
 * Step 3: Analyzes a failed prompt and suggests a safer/simpler version.
 */
export const getPromptFix = async (originalPrompt: string): Promise<string> => {
  try {
    const client = getAi();
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `You are an expert prompt engineer. The following image generation prompt failed, likely due to safety filters or prohibited content policies. 
      
      Original Prompt: "${originalPrompt}"
      
      Please rewrite this prompt to be fully compliant with safety guidelines (no violence, no explicit content, no gore) while preserving the original scene's meaning and visual style as much as possible for a general audience educational webtoon. 
      
      Return ONLY the rewritten prompt text in English.`,
    });
    return response.text?.trim() || originalPrompt;
  } catch (error) {
    console.error("Error getting prompt fix:", error);
    return originalPrompt;
  }
};

export const downloadImage = (dataUrl: string, filename: string) => {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};