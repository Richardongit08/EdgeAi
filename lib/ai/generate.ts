import { GoogleGenAI } from "@google/genai";
import type { ContentListUnion } from "@google/genai";

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  return new GoogleGenAI({ apiKey, httpOptions: { timeout: 6000 } });
}

function shouldFallback(error: unknown): boolean {
  if (error instanceof Error) {
    if (/timed out|timeout|404|429|503/i.test(error.message)) return true;
  }
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: number }).status;
    return status === 404 || status === 429 || status === 503;
  }
  return false;
}

export async function generateWithFallback(
  contents: ContentListUnion,
  config: Record<string, unknown> = {},
): Promise<string> {
  const ai = getGeminiClient();
  const models = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];
  let lastError: unknown;
  for (const model of models) {
    try {
      const responsePromise = ai.models.generateContent({
        model,
        contents,
        config,
      });
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Gemini generation timed out")), 6000),
        ),
      ]);
      return response.text ?? "";
    } catch (error) {
      lastError = error;
      if (model === "gemini-3.5-flash" && shouldFallback(error)) continue;
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Gemini generation failed.");
}
