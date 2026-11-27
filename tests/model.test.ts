import { describe, expect, it } from "vitest";
import { buildScoreMatrix } from "../lib/model/poisson";
import { deriveMarketProbabilities, matrixSum } from "../lib/model/markets";
import { calculateValue, removeMargin } from "../lib/model/value";
import { fuzzyTeamMatch, levenshtein } from "../lib/stats/fuzzy";
import type { MatchContext } from "../lib/stats/types";

describe("probability engine", () => {
  it("normalizes a scoreline matrix", () => {
    const matrix = buildScoreMatrix(1.4, 1.1);
    expect(matrixSum(matrix)).toBeCloseTo(1, 8);
  });

  it("derives 1X2 probabilities that sum to one", () => {
    const context: MatchContext = {
      homeName: "Chelsea",
      awayName: "Tottenham",
      leagueAvgGoals: 2.65,
      h2h: [],
      home: {
        form: [1, 1, 0, 1, 1, 0, 1, 1, 1, 0],
        goalsForHome: 18,
        goalsAgainstHome: 8,
        goalsForAway: 12,
        goalsAgainstAway: 10,
        injuries: [],
      },
      away: {
        form: [1, 0, 1, 1, 0, 0, 1, 1, 0, 1],
        goalsForHome: 15,
        goalsAgainstHome: 11,
        goalsForAway: 13,
        goalsAgainstAway: 9,
        injuries: [],
      },
    };
    const markets = deriveMarketProbabilities(context);
    expect(markets.home + markets.draw + markets.away).toBeCloseTo(1, 8);
  });

  it("removes bookmaker margin", () => {
    const fair = removeMargin([2, 3.5, 4], 0);
    expect(fair.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0);
    expect(fair[0]).toBeLessThan(0.5);
  });

  it("calculates edge and EV", () => {
    const result = calculateValue(0.55, 2.1, [2.1, 2.1]);
    expect(result.edge).toBeCloseTo(0.05, 8);
    expect(result.ev).toBeCloseTo(0.155, 8);
  });

  it("matches similar team names", () => {
    expect(levenshtein("Tottenham", "Tottenham Hotspur")).toBeGreaterThan(0);
    expect(fuzzyTeamMatch("Chelsea FC", [{ name: "Chelsea" }, { name: "Arsenal" }])?.name).toBe("Chelsea");
  });
});
