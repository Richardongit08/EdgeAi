import { describe, expect, it } from "vitest";
import { buildScoreMatrix } from "../lib/model/poisson";
import { deriveMarketProbabilities, matrixSum } from "../lib/model/markets";
import { calculateValue, removeMargin } from "../lib/model/value";
import { fuzzyTeamMatch, levenshtein } from "../lib/stats/fuzzy";
import { getEspnTeamStats } from "../lib/stats/espnStats";
import { findOddsFixture, type OddsFixture } from "../lib/stats/oddsApi";
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

  it("uses fuzzy team matching for odds fixtures without selecting unrelated events", () => {
    const fixtures: OddsFixture[] = [{
      id: "fixture-1",
      sport_key: "soccer_epl",
      commence_time: "2026-12-01T19:00:00Z",
      home_team: "Nottingham Forest",
      away_team: "Chelsea",
      bookmakers: [],
    }];
    expect(findOddsFixture(fixtures, "Nott'm Forest", "Chelsea FC")?.id).toBe("fixture-1");
    expect(findOddsFixture(fixtures, "Arsenal", "Liverpool")).toBeUndefined();
  });

  it("maps live ESPN standings and recent scoreboard form into team stats", () => {
    const standings = {
      children: [{
        standings: {
          entries: [{
            team: { displayName: "Chelsea" },
            stats: [
              { name: "gamesPlayed", value: 12 },
              { name: "wins", value: 7 },
              { name: "ties", value: 3 },
              { name: "losses", value: 2 },
              { name: "pointsFor", value: 24 },
              { name: "pointsAgainst", value: 14 },
              { name: "rank", value: 4 },
              { name: "form", displayValue: "W-D-W-L-W" },
            ],
          }],
        },
      }],
    };
    const scoreboard = {
      events: [{
        date: "2026-11-25T19:00Z",
        status: { type: { completed: true, state: "post" } },
        competitions: [{
          competitors: [
            { homeAway: "home", score: "2", team: { displayName: "Chelsea" } },
            { homeAway: "away", score: "1", team: { displayName: "Arsenal" } },
          ],
        }],
      }, {
        date: "2026-11-27T20:00Z",
        status: { type: { completed: false, state: "pre" } },
        competitions: [{
          competitors: [
            { homeAway: "home", score: "0", team: { displayName: "Chelsea" } },
            { homeAway: "away", score: "0", team: { displayName: "Arsenal" } },
          ],
        }],
      }],
    };
    const stats = getEspnTeamStats(standings, "Chelsea FC", scoreboard);
    expect(stats).toMatchObject({
      gamesPlayed: 12,
      wins: 7,
      draws: 3,
      losses: 2,
      goalsFor: 24,
      goalsAgainst: 14,
      standingsPosition: 4,
      form: [1],
    });
  });
});
