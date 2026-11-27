import { generateWithFallback } from "@/lib/ai/generate";

export type ChatIntent = "best_plays" | "analyse_match" | "explain_pick" | "general";

export interface RequestedMatch {
  home: string;
  away: string;
}

export function extractRequestedMatch(message: string): RequestedMatch | undefined {
  const cleaned = message.trim()
    .replace(/^please\s+/i, "")
    .replace(/^(?:can|could|would)\s+you\s+/i, "")
    .replace(/^(?:analyse|analyze|analysis(?:\s+of)?|break\s+down|look\s+at|check|tell\s+me\s+about)\s+/i, "")
    .replace(/^(?:the\s+)?(?:fixture|match|game)\s+/i, "")
    .replace(/^for\s+/i, "")
    .replace(/\s+(?:tonight|today|tomorrow|this\s+(?:evening|weekend|week)|next\s+(?:week|weekend))\b.*$/i, "")
    .trim();
  const match = cleaned.match(/^(.+?)\s+(?:vs|versus|v)\s+(.+?)$/i);
  if (!match) return undefined;
  return { home: match[1].trim(), away: match[2].trim() };
}

export function extractPickLimit(message: string): number | undefined {
  const match = message.match(/\b(?:give\s+me|show\s+me|top)\s+(\d{1,2})\s+(?:games?|picks?)\b/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 50) : undefined;
}

function isBestPlaysRequest(message: string): boolean {
  return /\bbest\s+plays?\b|\bhigh\s+probability\b|\bsafest\b|\btop\s+(?:\d{1,2}\s+)?picks?\b|\bgive\s+me\s+\d{1,2}\s+(?:games?|picks?)\b/i.test(message);
}

export async function classifyIntent(message: string): Promise<ChatIntent> {
  if (extractRequestedMatch(message)) return "analyse_match";
  if (isBestPlaysRequest(message)) return "best_plays";
  try {
    const response = await generateWithFallback(
      `Classify this football chat message into exactly one category: best_plays, analyse_match, explain_pick, or general.\n\nMessage: ${message}`,
      { temperature: 0, responseMimeType: "application/json" },
    );
    const parsed = JSON.parse(response) as { intent?: unknown };
    if (parsed.intent === "best_plays" || parsed.intent === "analyse_match" || parsed.intent === "explain_pick" || parsed.intent === "general") {
      return parsed.intent;
    }
  } catch {
    // Deterministic fallback keeps chat usable when Gemini is unavailable.
  }
  const text = message.toLowerCase();
  if (/best|today|rank|value|safe|over|under|high probability|top picks/.test(text)) return "best_plays";
  if (/why|because|justify|reason/.test(text)) return "explain_pick";
  if (/analyse|analysis|vs|versus|match|chelsea|spurs|arsenal/.test(text)) return "analyse_match";
  return "general";
}
