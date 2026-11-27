import { z } from "zod";

export const extractedBetSchema = z.object({
  home: z.string().min(1),
  away: z.string().min(1),
  league: z.string().optional(),
  date: z.string().optional(),
  market: z.string().min(1),
  selection: z.string().min(1),
  odds: z.number().positive().nullable().optional(),
});

export type ExtractedBet = z.infer<typeof extractedBetSchema>;

export interface TeamStats {
  form: number[];
  sampleSize?: number;
  gamesPlayed?: number;
  wins?: number;
  draws?: number;
  losses?: number;
  goalsFor?: number;
  goalsAgainst?: number;
  goalsForHome: number;
  goalsAgainstHome: number;
  goalsForAway: number;
  goalsAgainstAway: number;
  xgFor?: number;
  xgAgainst?: number;
  injuries: string[];
  standingsPosition?: number;
}

export interface MatchContext {
  home: TeamStats;
  away: TeamStats;
  h2h: Array<{ homeGoals: number; awayGoals: number }>;
  leagueAvgGoals: number;
  homeName: string;
  awayName: string;
}

export type Confidence = "high" | "medium" | "low";

export interface Pick {
  match: string;
  market: string;
  selection: string;
  modelProb: number;
  bookOdds: number | null;
  fairProb: number | null;
  edge: number | null;
  ev: number | null;
  confidence: Confidence;
  justification: string;
  dataQuality: "complete" | "partial" | "insufficient" | "model_only" | "limited";
}
