import { extractedBetSchema, type ExtractedBet } from "@/lib/stats/types";
import { generateWithFallback } from "@/lib/ai/generate";

export async function extractBetsFromImage(base64Image: string, mimeType: string): Promise<ExtractedBet[]> {
  const content = await generateWithFallback(
    [{
      role: "user",
      parts: [
        {
          text: "Read this tall vertical bet-slip screenshot (SportyBet, Bet9ja, etc.) from top to bottom. Extract every visible match, including home team, away team, optional league/date, market, selection, and decimal odds. Return JSON with a 'bets' array. Never infer missing values or hallucinate teams.",
        },
        { inlineData: { mimeType, data: base64Image } },
      ],
    }],
    { temperature: 0, responseMimeType: "application/json" },
  );
  if (!content) throw new Error("The vision model returned no extraction.");
  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned) as unknown;
  const object = parsed as { bets?: unknown };
  const bets = extractedBetSchema.array().parse(object.bets ?? []);
  return bets;
}
