import { generateWithFallback } from "@/lib/ai/generate";

export type ChatIntent = "best_plays" | "analyse_match" | "explain_pick" | "general";

export async function classifyIntent(message: string): Promise<ChatIntent> {
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
  if (/best|today|rank|value|safe|over|under/.test(text)) return "best_plays";
  if (/why|because|justify|reason/.test(text)) return "explain_pick";
  if (/analyse|analysis|vs|versus|match|chelsea|spurs|arsenal/.test(text)) return "analyse_match";
  return "general";
}
