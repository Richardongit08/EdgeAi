import { generateWithFallback } from "@/lib/ai/generate";

export type ChatIntent = "best_plays" | "analyse_match" | "explain_pick" | "open_board" | "general";
export type RiskProfile = "safe" | "balanced" | "risky" | "multi_combo";
export type TargetMarket =
  | "all"
  | "goals"
  | "correct_score"
  | "total_shots"
  | "btts"
  | "1x2"
  | "double_chance"
  | "draw_no_bet"
  | "asian_handicap";

export interface ParsedBettingRequest {
  gameCount?: number;
  targetTotalOdds?: number;
  riskProfile: RiskProfile;
}

export interface ParsedChatIntent extends ParsedBettingRequest {
  intent: ChatIntent;
}

export interface RequestedMatch {
  home: string;
  away: string;
}

export function extractRequestedMatch(message: string): RequestedMatch | undefined {
  const cleaned = normalizeFootballQuestion(message)
    .replace(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?/i, "")
    .replace(/^(?:what(?:'s| is)\s+)?(?:the\s+)?(?:safest|best|strongest|likely)\s+(?:play|pick|bet)\s+(?:in|for)\s+/i, "")
    .replace(/^(?:analyse|analyze|analysis(?:\s+of)?|break\s+down|look\s+at|check|tell\s+me\s+about)\s+/i, "")
    .replace(/^(?:the\s+)?(?:fixture|match|game)\s+/i, "")
    .replace(/[?!]+$/g, "")
    .trim();
  const match = cleaned.match(/^(.+?)\s+(?:vs|versus|v)\s+(.+?)(?:\s+(?:tonight|today|tomorrow|this\s+(?:evening|weekend|week)|next\s+(?:week|weekend)|for\s+.+))?$/i);
  if (!match) return undefined;
  return { home: match[1].trim(), away: match[2].trim().replace(/[?!.,]+$/g, "") };
}

export function extractPickLimit(message: string): number | undefined {
  const explicitLimit = message.match(
    /\b(?:give(?:\s+me)?|show\s+me|top)\s+(\d{1,2})\s+(?:(?:best\s+)?(?:games?|picks?|options?))\b/i,
  );
  const marketLimit = message.match(
    /\b(\d{1,2})\s+(?:correct\s+score|over\s*\/\s*under|over|under|btts|both\s+teams\s+to\s+score|total\s+shots?|double\s+chance|draw\s+no\s+bet|dnb|asian\s+handicap|1x2)\s+games?\b/i,
  );
  const match = explicitLimit ?? marketLimit;
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 50) : undefined;
}

function hasExplicitRiskProfile(message: string): boolean {
  return /\b(?:safe|safest|low[-\s]risk|risky|high[-\s]odds?|multi(?:[_\s-]*combo)?|combo|combination)\b/i.test(message);
}

export function parseBettingRequest(message: string): ParsedBettingRequest {
  const targetOddsMatch = message.match(
    /\b(?:(?:sum(?:\s+up\s+to)?|reach(?:\s+up\s+to)?|target(?:\s+total)?|to\s+give|give(?:\s+me)?)\s+)?(\d{1,3}(?:\.\d+)?)\s+odds\b/i,
  );
  const gameCountMatch = message.match(
    /\b(\d{1,2})\s+(?:(?:safe|safest|risky|balanced|high[\s-]+odds|multi(?:[_\s-]+combo)?|combo|combination)\s+)?games?\b/i,
  );
  const riskProfile: RiskProfile = /\bmulti(?:[_\s-]*combo)?\b|\bcombo\b|\bcombination\b/i.test(message)
    ? "multi_combo"
    : /\brisky\b|\bhigh[-\s]odds?\b/i.test(message)
      ? "risky"
      : /\bsafe(?:st)?\b|\blow[-\s]risk\b/i.test(message)
        ? "safe"
        : "balanced";
  const targetTotalOdds = targetOddsMatch ? Number(targetOddsMatch[1]) : undefined;
  const gameCount = gameCountMatch ? Number(gameCountMatch[1]) : undefined;
  return {
    ...(gameCount !== undefined && gameCount > 0 ? { gameCount: Math.min(gameCount, 50) } : {}),
    ...(targetTotalOdds !== undefined && targetTotalOdds > 1
      ? { targetTotalOdds }
      : {}),
    riskProfile,
  };
}

export async function parseChatIntent(message: string): Promise<ParsedChatIntent> {
  return {
    intent: await classifyIntent(message),
    ...parseBettingRequest(message),
  };
}

function isBestPlaysRequest(message: string): boolean {
  return /\bbest\s+plays?\b|\bhigh[- ]probability\b|\bsafest\b|\blow[- ]risk\b|\btop\s+(?:\d{1,2}\s+)?picks?\b|\bgive\s+me\s+\d{1,2}\s+(?:games?|picks?)\b|\b(?:across|all)\s+(?:the\s+)?(?:games|fixtures|leagues|slate)\b/i.test(message);
}

export function normalizeFootballQuestion(message: string): string {
  return message
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/\bmanchester\s+united\b/gi, "Man Utd")
    .replace(/\bmanchester\s+city\b/gi, "Man City")
    .replace(/\bvs\.?\b/gi, "vs")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldOpenAnalysisBoard(message: string): boolean {
  return /\bopen\s+(?:the\s+)?analysis\s+board\b|\bshow\s+(?:the\s+)?(?:analysis\s+)?board\b|\bfull\s+breakdown\b|\bshow\s+stats?\s+cards\b/i.test(message);
}

export function extractTargetMarket(message: string): TargetMarket {
  const text = normalizeFootballQuestion(message).toLowerCase();
  if (/\bcorrect\s+score\b/.test(text)) return "correct_score";
  if (/\btotal\s+shots?\b|\bshots?\s+(?:market|line)\b/.test(text)) return "total_shots";
  if (/\bbtts\b|\bboth\s+teams\s+to\s+score\b/.test(text)) return "btts";
  if (/\bdouble\s+chance\b/.test(text)) return "double_chance";
  if (/\bdraw\s+no\s+bet\b|\bdnb\b/.test(text)) return "draw_no_bet";
  if (/\basian\s+handicap\b|\bhandicap\b/.test(text)) return "asian_handicap";
  if (/\b1x2\b|\bmatch\s+(?:winner|result)\b|\bfor\s+(?:the\s+)?win\b/.test(text)) return "1x2";
  if (/\bgoals?\b|\bover\b|\bunder\b|\btotal\b/.test(text)) return "goals";
  return "all";
}

export async function classifyIntent(message: string): Promise<ChatIntent> {
  const normalized = normalizeFootballQuestion(message);
  if (shouldOpenAnalysisBoard(normalized)) return "open_board";
  if (extractRequestedMatch(normalized)) return "analyse_match";
  if (
    /^\d{1,2}\s+.+\s+games?\b/i.test(normalized) &&
    extractTargetMarket(normalized) !== "all"
  ) return "best_plays";
  const bettingRequest = parseBettingRequest(normalized);
  if (
    bettingRequest.gameCount !== undefined ||
    bettingRequest.targetTotalOdds !== undefined ||
    hasExplicitRiskProfile(normalized)
  ) return "best_plays";
  if (/^(?:for|show|give me)\s+(?:the\s+)?(?:over|under|goals?|correct score|total shots?|btts|1x2|double chance|draw no bet|asian handicap)\b/i.test(normalized)) {
    return "analyse_match";
  }
  if (isBestPlaysRequest(normalized)) return "best_plays";
  try {
    const response = await generateWithFallback(
      `Classify this football chat message into exactly one category: best_plays, analyse_match, explain_pick, open_board, or general. Return JSON with an intent property.\n\nMessage: ${normalized}`,
      { temperature: 0, responseMimeType: "application/json" },
    );
    const parsed = JSON.parse(response) as { intent?: unknown };
    if (parsed.intent === "best_plays" || parsed.intent === "analyse_match" || parsed.intent === "explain_pick" || parsed.intent === "open_board" || parsed.intent === "general") {
      return parsed.intent;
    }
  } catch {
    // Keep deterministic classification available when Gemini is not.
  }
  const text = normalized.toLowerCase();
  if (/best|today|rank|value|high probability|top picks/.test(text)) return "best_plays";
  if (/why|because|justify|reason/.test(text)) return "explain_pick";
  return "general";
}
