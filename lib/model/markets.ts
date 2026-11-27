import type { MatchContext, TeamStats } from "@/lib/stats/types";
import { buildScoreMatrix, estimateExpectedGoals, type ScoreMatrix } from "@/lib/model/poisson";

export interface MarketProbabilities {
  lambdaHome: number;
  lambdaAway: number;
  home: number;
  draw: number;
  away: number;
  doubleChance: {
    homeOrDraw: number;
    homeOrAway: number;
    drawOrAway: number;
  };
  over: Record<number, number>;
  under: Record<number, number>;
  bttsYes: number;
  bttsNo: number;
  homeHandicap: Record<string, number>;
  awayHandicap: Record<string, number>;
  topCorrectScores: Array<{ score: string; probability: number }>;
}

function strength(stats: TeamStats, side: "home" | "away", leagueAvgGoals: number) {
  const goalsFor = side === "home" ? stats.goalsForHome : stats.goalsForAway;
  const goalsAgainst = side === "home" ? stats.goalsAgainstHome : stats.goalsAgainstAway;
  const sample = Math.max(stats.sampleSize ?? stats.form.length, 1);
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
        under[line] = (under[line] ?? 0) + (total < line ? p : 0);
      }
    }
  }

  const homeHandicap: Record<string, number> = {};
  const awayHandicap: Record<string, number> = {};
  for (const line of [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5]) {
    let homeCover = 0;
    let awayCover = 0;
    for (let h = 0; h <= 10; h += 1) {
      for (let a = 0; a <= 10; a += 1) {
        const probability = matrix[h][a];
        if (h + line > a) homeCover += probability;
        if (a + line > h) awayCover += probability;
      }
    }
    homeHandicap[String(line)] = homeCover;
    awayHandicap[String(line)] = awayCover;
  }

  const topCorrectScores = matrix.flatMap((row, h) =>
    row.map((probability, a) => ({ score: `${h}-${a}`, probability })),
  ).sort((a, b) => b.probability - a.probability).slice(0, 3);

  return {
    lambdaHome,
    lambdaAway,
    home,
    draw,
    away,
    doubleChance: {
      homeOrDraw: home + draw,
      homeOrAway: home + away,
      drawOrAway: draw + away,
    },
    over,
    under,
    bttsYes,
    bttsNo: 1 - bttsYes,
    homeHandicap,
    awayHandicap,
    topCorrectScores,
  };
}

export function matrixSum(matrix: ScoreMatrix): number {
  return matrix.flat().reduce((sum, value) => sum + value, 0);
}
