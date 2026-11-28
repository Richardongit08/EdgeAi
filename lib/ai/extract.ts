import { extractedBetSchema, type ExtractedBet } from "@/lib/stats/types";
import { generateWithFallback } from "@/lib/ai/generate";

export interface EncodedBetSlipImage {
  base64Image: string;
  mimeType: string;
}

export async function extractBetsFromImage(
  base64Image: string | EncodedBetSlipImage[],
  mimeType?: string,
): Promise<ExtractedBet[]> {
  const images = typeof base64Image === "string"
    ? [{ base64Image, mimeType: mimeType ?? "image/jpeg" }]
    : base64Image;
  if (images.length === 0) throw new Error("At least one image is required for extraction.");

  const content = await generateWithFallback(
    [{
      role: "user",
      parts: [
        {
          text: "Read every provided football screenshot, including bookmaker bet slips (SportyBet, Bet9ja, 1xBet, Betway) and tipster posts. Extract every visible match in reading order. Return JSON only as {\"bets\":[{\"home\":\"...\",\"away\":\"...\",\"league\":\"...\",\"date\":\"...\",\"market\":\"...\",\"selection\":\"...\",\"odds\":1.25}]}. Each bet must include home, away, market, and selection; league, date, and decimal odds are optional. Never reject a pick because odds are absent, and never invent teams, selections, or odds. Preserve team-specific totals, Early Goals, Asian Handicaps, corners, shots, and other explicit markets. Normalize common shorthand: \"Away to score\" to market \"Team Total Goals\" and selection \"Away Over 0.5 Goals\"; \"Home to score\" to \"Home Over 0.5 Goals\"; \"Home 2up\" to market \"1X2\" and selection \"Home Win (home team) / 2UP\"; \"Away 2up\" to \"Away Win (away team) / 2UP\"; \"2nd Half over 0.5\" to market \"2nd Half Total Goals\" and selection \"Over 0.5 Goals\". For team-specific Over/Under, preserve the team in the market (for example \"Maccabi Tel Aviv FC Team Total Goals\") and the exact line and side in selection (for example \"Under 3.5\"). For handicap picks, include the team and signed handicap in selection. Omit odds entirely when none are visible.",
        },
        ...images.map(({ base64Image: data, mimeType: imageMimeType }) => ({
          inlineData: { mimeType: imageMimeType, data },
        })),
      ],
    }],
    { temperature: 0, responseMimeType: "application/json" },
  );
  if (!content) throw new Error("The vision model returned no extraction.");
  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error("The vision model returned invalid extraction JSON.");
  }
  const parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1)) as unknown;
  const object = parsed as { bets?: unknown };
  const bets = extractedBetSchema.array().parse(object.bets ?? []);
  return bets;
}
