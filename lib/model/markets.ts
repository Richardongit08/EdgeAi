import type { MatchContext, TeamStats } from "@/lib/stats/types";
import { buildScoreMatrix, estimateExpectedGoals, type ScoreMatrix } from "@/lib/model/poisson";

export interface MarketProbabilities {
  home: number;
  draw: number;
  away: number;
  over: Record<number, number>;
  under: Record<number, number>;
  bttsYes: number;
  bttsNo: number;
  topCorrectScores: Array<{ score: string; probability: number }>;
}

function strength(stats: TeamStats, side: "home" | "away", leagueAvgGoals: number) {
  const goalsFor = side === "home" ? stats.goalsForHome : stats.goalsForAway;
  const goalsAgainst = side === "home" ? stats.goalsAgainstHome : stats.goalsAgainstAway;
  const sample = Math.max(stats.form.length, 1);
  const attack = goalsFor / Math.max(sample * leagueAvgGoals / 2, 1);
  const defence = 2 - goalsAgainst / Math.max(sample * leagueAvgGoals / 2, 1);
  return { attack: Math.max(0.55, Math.min(1.45, attack)), defence: Math.max(0.55, Math.min(1.45, defence)) };
}

export function deriveMarketProbabilities(context: MatchContext): MarketProbabilities {
  const homeStrength = strength(context.home, "home", context.leagueAvgGoals);
  const awayStrength = strength(context.away, "away", context.leagueAvgGoals);
  const { lambdaHome, lambdaAway } = estimateExpectedGoals(
    homeStrength.attack,
    homeStrength.defence,
    awayStrength.attack,
    awayStrength.defence,
    context.leagueAvgGoals,
  );
  const matrix = buildScoreMatrix(lambdaHome, lambdaAway);

  let home = 0;
  let draw = 0;
  let away = 0;
  let bttsYes = 0;
  const over: Record<number, number> = {};
  const under: Record<number, number> = {};

  for (let h = 0; h <= 10; h += 1) {
    for (let a = 0; a <= 10; a += 1) {
      const p = matrix[h][a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
      if (h > 0 && a > 0) bttsYes += p;
      const total = h + a;
      for (const line of [0.5, 1.5, 2.5, 3.5]) {
        over[line] = (over[line] ?? 0) + (total > line ? p : 0);
        under[line] = (under[line] ?? 0) + (total < line + 1 ? p : 0);
      }
    }
  }

  const topCorrectScores = matrix.flatMap((row, h) =>
    row.map((probability, a) => ({ score: `${h}-${a}`, probability })),
  ).sort((a, b) => b.probability - a.probability).slice(0, 3);

  return {
    home,
    draw,
    away,
    over,
    under,
    bttsYes,
    bttsNo: 1 - bttsYes,
    topCorrectScores,
  };
}

export function matrixSum(matrix: ScoreMatrix): number {
  return matrix.flat().reduce((sum, value) => sum + value, 0);
}
