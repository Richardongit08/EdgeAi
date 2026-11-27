import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

export type ChatIntent = "best_plays" | "analyse_match" | "show_board" | "explain_pick" | "general";
export type TargetMarket =
  | "all"
  | "Correct Score"
  | "Over/Under Goals"
  | "Total Shots"
  | "BTTS"
  | "Double Chance"
  | "1X2"
  | "Asian Handicap";

export interface RequestedMatch {
  home: string;
  away: string;
}

export interface FixtureReference {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

export interface ChatContext {
  lastMatchedFixture?: FixtureReference;
  lastFixtures?: FixtureReference[];
  lastPicks?: Array<{ match: string; market: string; selection: string }>;
}

export interface ChatClassification {
  intent: ChatIntent;
  limit: number;
  distinctMatches: boolean;
  targetMarket: TargetMarket;
  sortBy: "probability" | "ev";
  openBoard: boolean;
  allMarkets: boolean;
  useContext: boolean;
  selectionFilter?: string;
  requestedMatch?: RequestedMatch;
  requestedTeam?: string;
}

const fixtureReferenceSchema = z.object({
  id: z.string().min(1).max(100),
  sport_key: z.string().min(1).max(100),
  commence_time: z.string().min(1).max(100),
  home_team: z.string().min(1).max(100),
  away_team: z.string().min(1).max(100),
});

const chatContextSchema = z.object({
  lastMatchedFixture: fixtureReferenceSchema.optional(),
  lastFixtures: z.array(fixtureReferenceSchema).max(8).optional(),
  lastPicks: z.array(z.object({
    match: z.string().max(200),
    market: z.string().max(100),
    selection: z.string().max(100),
  })).max(12).optional(),
}).optional();

const modelIntentSchema = z.object({
  intent: z.enum(["best_plays", "analyse_match", "show_board", "explain_pick", "general"]),
  limit: z.number().int().positive().max(50).optional(),
  distinctMatches: z.boolean().optional(),
  targetMarket: z.enum([
    "all",
    "Correct Score",
    "Over/Under Goals",
    "Total Shots",
    "BTTS",
    "Double Chance",
    "1X2",
    "Asian Handicap",
  ]).optional(),
  sortBy: z.enum(["probability", "ev"]).optional(),
  openBoard: z.boolean().optional(),
});

const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function parseChatContext(value: unknown): ChatContext {
  const parsed = chatContextSchema.safeParse(value);
  return parsed.success ? parsed.data ?? {} : {};
}

export function extractRequestedMatch(message: string): RequestedMatch | undefined {
  const cleaned = message.trim()
    .replace(/^please\s+/i, "")
    .replace(/^i\s+(?:want|would\s+like)\s+to\s+/i, "")
    .replace(/^(?:can|could|would)\s+you\s+/i, "")
    .replace(/^(?:what|how)\s+about\s+/i, "")
    .replace(/^(?:analyse|analyze|analysis(?:\s+of)?|break\s+down|look\s+at|check|tell\s+me\s+about)\s+/i, "")
    .replace(/^(?:the\s+)?(?:fixture|match|game)\s+/i, "")
    .replace(/^for\s+/i, "")
    .replace(/\s+(?:tonight|today|tomorrow|this\s+(?:evening|weekend|week)|next\s+(?:week|weekend))\b.*$/i, "")
    .replace(/\s+(?:for\s+)?(?:all\s+markets|full\s+breakdown|goals?|shots?|correct\s+scores?|btts|gg|double\s+chance|1x2|asian\s+handicap)\s*[?.!,]*$/i, "")
    .replace(/[?.!,]+$/g, "")
    .trim();
  const match = cleaned.match(/^(.+?)\s+(?:vs|versus|v)\s+(.+?)$/i);
  if (!match) return undefined;
  return { home: match[1].trim(), away: match[2].trim() };
}

export function extractRequestedTeam(message: string): string | undefined {
  const match = message.trim().match(/^(?:please\s+)?(?:check|analyse|analyze|look\s+at)\s+(.+?)(?:\s+for\s+(?:goals?|shots?|correct\s+scores?|btts|gg|double\s+chance|1x2|asian\s+handicap))?(?:\s+(?:tonight|today|tomorrow))?[?.!]*$/i);
  if (!match || /\b(?:best|picks?|games?|matches?)\b/i.test(match[1])) return undefined;
  return match[1].trim();
}

function isBoardRequest(message: string): boolean {
  return /\b(?:show|open|view|display)(?:\s+me)?\s+(?:the\s+)?(?:full\s+)?(?:analysis\s+)?board\b|\bfull\s+breakdown\b|\bshow(?:\s+me)?\s+cards\b|\bopen\s+cards\b|\bfilters\b|\bfull\s+stats(?:\s+explanation)?\b|\bexplain\s+why\b|\bwhy\s+(?:did|was|were)\s+(?:you\s+)?(?:pick|choose)\b|\bexplain\s+(?:this|the)\s+pick\b/i.test(message);
}

function extractMarket(message: string): TargetMarket {
  const text = message.toLowerCase();
  if (/\bcorrect\s+scores?\b|\bscoreline\b/.test(text)) return "Correct Score";
  if (/\btotal\s+shots?\b|\bshots?\s+on\s+target\b|\bfor\s+shots?\b|\bshots?\b/.test(text)) return "Total Shots";
  if (/\bdouble\s+chance\b|\b1x\b|\bx2\b/.test(text)) return "Double Chance";
  if (/\basian\s+handicap\b|\bhandicap\b|\bspread\b/.test(text)) return "Asian Handicap";
  if (/\bgg\b|\bbtts\b|\bboth\s+teams?\s+(?:to\s+)?score\b/.test(text)) return "BTTS";
  if (/\b1x2\b|\bstraight\s+win\b|\bmatch\s+winner\b|\bhome\s+win\b|\baway\s+win\b/.test(text)) return "1X2";
  if (/\bgoals?\b|\bover\s+\d+(?:\.\d+)?\b|\bunder\s+\d+(?:\.\d+)?\b/.test(text)) return "Over/Under Goals";
  return "all";
}

function extractCount(message: string): { limit?: number; distinctMatches: boolean } {
  const match = message.toLowerCase().match(/\b(?:(?:give|show)\s+me\s+|top\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+(?:sure|safest|high[- ](?:chance|probability)))?\s+(games?|matches?|picks?)\b/i);
  if (!match) return { distinctMatches: false };
  const limit = numberWords[match[1]] ?? Number(match[1]);
  return {
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : undefined,
    distinctMatches: /games?|matches?/i.test(match[2]),
  };
}

export function extractPickLimit(message: string): number | undefined {
  return extractCount(message).limit;
}

function isSlateRequest(message: string, count: { limit?: number }): boolean {
  return count.limit !== undefined ||
    /\bbest\s+(?:plays?|goal\s+picks?|picks?)\b|\bhigh[- ]?(?:probability|chance)\b|\bsafest\b|\btop\s+picks?\b|\bsure\s+games?\b|\bvalue\s+picks?\b|\btonight'?s\s+(?:games?|fixtures?)\b/i.test(message) ||
    /\b(?:value|ev|edge)\b|\b(?:today|tonight)\b.*\b(?:picks?|games?|fixtures?)\b/i.test(message) ||
    /\b(?:straight\s+win|over\s+\d+(?:\.\d+)?|under\s+\d+(?:\.\d+)?|gg|btts)\b/i.test(message);
}

function getSelectionFilter(message: string, targetMarket: TargetMarket): string | undefined {
  const line = message.match(/\b(over|under)\s+(\d+(?:\.\d+)?)\b/i);
  if (targetMarket === "Over/Under Goals" && line) return `${line[1]} ${line[2]} Goals`;
  if (targetMarket === "Total Shots" && line) return `${line[1]} ${line[2]}`;
  if (targetMarket === "BTTS" && /\b(?:gg|btts)\b/i.test(message)) return "Yes";
  if (targetMarket === "1X2" && /\bstraight\s+win\b/i.test(message)) return "exclude:draw";
  return undefined;
}

function isMarketFollowUp(message: string, market: TargetMarket): boolean {
  return market !== "all" &&
    /^(?:and\s+)?(?:for\s+)?(?:goals?|shots?|correct\s+scores?|1x2|double\s+chance|btts|gg|asian\s+handicap|over\s+\d+(?:\.\d+)?|under\s+\d+(?:\.\d+)?|what\s+about\s+.+?)[?.!]*$/i.test(message.trim());
}

async function classifyWithGemini(message: string, context: ChatContext): Promise<z.infer<typeof modelIntentSchema> | undefined> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) return undefined;
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 4000 } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: [
          "Classify the football request. Return JSON only. Never promise an outcome. Use the context only to resolve short follow-ups. Do not invent team names. Set openBoard true only when the user explicitly asks to show/open the board, cards, filters, or a full statistical breakdown; keep it false for normal pick requests.",
          `Message: ${message}`,
          `Context: ${JSON.stringify({
            lastMatchedFixture: context.lastMatchedFixture
              ? `${context.lastMatchedFixture.home_team} vs ${context.lastMatchedFixture.away_team}`
              : null,
            lastFixtures: context.lastFixtures?.map((fixture) => `${fixture.home_team} vs ${fixture.away_team}`) ?? [],
            lastPicks: context.lastPicks?.map((pick) => `${pick.match}: ${pick.selection}`) ?? [],
          })}`,
          'JSON shape: {"intent":"best_plays|analyse_match|show_board|explain_pick|general","limit":5,"distinctMatches":false,"targetMarket":"all|Correct Score|Over/Under Goals|Total Shots|BTTS|Double Chance|1X2|Asian Handicap","sortBy":"probability|ev","openBoard":false}',
        ].join("\n\n"),
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            required: ["intent", "distinctMatches", "targetMarket", "sortBy", "openBoard"],
            properties: {
              intent: {
                type: "STRING",
                enum: ["best_plays", "analyse_match", "show_board", "explain_pick", "general"],
              },
              limit: { type: "INTEGER" },
              distinctMatches: { type: "BOOLEAN" },
              targetMarket: {
                type: "STRING",
                enum: ["all", "Correct Score", "Over/Under Goals", "Total Shots", "BTTS", "Double Chance", "1X2", "Asian Handicap"],
              },
              sortBy: { type: "STRING", enum: ["probability", "ev"] },
              openBoard: { type: "BOOLEAN" },
            },
          },
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Intent classification timed out.")), 4000);
      }),
    ]);
    const parsed = modelIntentSchema.safeParse(JSON.parse(response.text ?? ""));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function classifyMessage(message: string, context: ChatContext = {}): Promise<ChatClassification> {
  const text = message.trim();
  const targetMarket = extractMarket(text);
  const count = extractCount(text);
  const allMarkets = /\ball\s+markets\b/i.test(text);
  const selectionFilter = getSelectionFilter(text, targetMarket);
  const openBoard = isBoardRequest(text);
  const requestedMatch = extractRequestedMatch(text);
  const requestedTeam = requestedMatch ? undefined : extractRequestedTeam(text);
  const hasContext = Boolean(context.lastMatchedFixture || context.lastFixtures?.length);
  const useContext = (isMarketFollowUp(text, targetMarket) || allMarkets) && hasContext;
  const sortBy = /\b(?:value|ev|edge)\b/i.test(text) ? "ev" : "probability";

  if (openBoard) {
    return {
      intent: "show_board",
      limit: count.limit ?? 5,
      distinctMatches: count.distinctMatches,
      targetMarket,
      sortBy,
      openBoard: true,
      allMarkets,
      useContext: false,
      selectionFilter,
    };
  }
  if (requestedMatch || requestedTeam) {
    return {
      intent: "analyse_match",
      limit: count.limit ?? (allMarkets ? 50 : 1),
      distinctMatches: false,
      targetMarket,
      sortBy,
      openBoard: false,
      allMarkets,
      useContext: false,
      selectionFilter,
      requestedMatch,
      requestedTeam,
    };
  }
  if (useContext) {
    return {
      intent: context.lastMatchedFixture ? "analyse_match" : "best_plays",
      limit: count.limit ?? (context.lastMatchedFixture && !allMarkets ? 1 : 5),
      distinctMatches: count.distinctMatches,
      targetMarket,
      sortBy,
      openBoard: false,
      allMarkets,
      useContext: true,
      selectionFilter,
    };
  }
  if (isSlateRequest(text, count) || (targetMarket !== "all" && !requestedMatch && !requestedTeam)) {
    return {
      intent: "best_plays",
      limit: count.limit ?? 5,
      distinctMatches: count.distinctMatches,
      targetMarket,
      sortBy,
      openBoard: false,
      allMarkets,
      useContext: false,
      selectionFilter,
    };
  }
  if (/^(?:please\s+)?(?:analyse|analyze)\s+(?:a|the)\s+match[?.!]*$/i.test(text) && !hasContext) {
    return {
      intent: "general",
      limit: 5,
      distinctMatches: false,
      targetMarket,
      sortBy,
      openBoard: false,
      allMarkets,
      useContext: false,
      selectionFilter,
    };
  }

  const modelResult = await classifyWithGemini(text, context);
  if (modelResult?.intent === "show_board" && modelResult.openBoard === true) {
    return {
      intent: "show_board",
      limit: count.limit ?? 5,
      distinctMatches: count.distinctMatches,
      targetMarket,
      sortBy,
      openBoard: true,
      allMarkets,
      useContext: false,
      selectionFilter,
    };
  }
  const intent = modelResult?.intent === "show_board" ? "general" : modelResult?.intent ?? "general";
  return {
    intent,
    limit: count.limit ?? modelResult?.limit ?? (intent === "analyse_match" ? (allMarkets ? 50 : 1) : 5),
    distinctMatches: count.distinctMatches || modelResult?.distinctMatches === true,
    targetMarket: targetMarket === "all" ? modelResult?.targetMarket ?? "all" : targetMarket,
    sortBy: sortBy === "ev" ? "ev" : modelResult?.sortBy ?? "probability",
    openBoard: false,
    allMarkets,
    useContext: intent === "analyse_match" && hasContext,
    selectionFilter,
  };
}

export async function classifyIntent(message: string): Promise<ChatIntent> {
  return (await classifyMessage(message)).intent;
}
