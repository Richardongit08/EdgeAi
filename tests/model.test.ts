import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyIntent,
  classifyMessage,
  extractPickLimit,
  extractRequestedMatch,
} from "../lib/ai/intent";
import { analyseFixtures, rankPicks } from "../lib/model/analyseFixtures";
import { buildScoreMatrix } from "../lib/model/poisson";
import { deriveMarketProbabilities, matrixSum } from "../lib/model/markets";
import { deriveShotMarketProbabilities } from "../lib/model/shots";
import { calculateValue, removeMargin } from "../lib/model/value";
import { fuzzyTeamMatch, levenshtein } from "../lib/stats/fuzzy";
import { getEspnTeamShotAverages, getEspnTeamStats } from "../lib/stats/espnStats";
import { findOddsFixture, type OddsFixture } from "../lib/stats/oddsApi";
import type { MatchContext, Pick } from "../lib/stats/types";

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
    expect(markets.over[2.5] + markets.under[2.5]).toBeCloseTo(1, 8);
    expect(markets.doubleChance.homeOrDraw).toBeCloseTo(markets.home + markets.draw, 8);
    expect(markets.bttsYes + markets.bttsNo).toBeCloseTo(1, 8);
    expect(markets.topCorrectScores).toHaveLength(3);
    expect(markets.topCorrectScores[0].probability).toBeGreaterThanOrEqual(markets.topCorrectScores[1].probability);
    expect(markets.topCorrectScores.every(({ score }) => /^\d+-\d+$/.test(score))).toBe(true);
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

  it("matches requested teams in either fixture order", () => {
    const fixtures: OddsFixture[] = [{
      id: "fixture-reversed",
      sport_key: "soccer_epl",
      commence_time: "2026-12-01T19:00:00Z",
      home_team: "Werder Bremen",
      away_team: "Borussia Monchengladbach",
      bookmakers: [],
    }];
    expect(findOddsFixture(fixtures, "borrusia", "werder bremen")?.id).toBe("fixture-reversed");
  });

  it("recognizes best-play phrasing and requested match limits", async () => {
    expect(await classifyIntent("Give me 4 games today")).toBe("best_plays");
    expect(await classifyIntent("What are the safest picks?")).toBe("best_plays");
    expect(extractPickLimit("Show me 12 picks")).toBe(12);
    expect(extractRequestedMatch("Please analyse Nottingham Forest vs Chelsea tonight")).toEqual({
      home: "Nottingham Forest",
      away: "Chelsea",
    });
    expect(extractRequestedMatch("I want to analyse Chelsea vs Arsenal for goals")).toEqual({
      home: "Chelsea",
      away: "Arsenal",
    });
    expect(extractRequestedMatch("What about Chelsea vs Arsenal for all markets?")).toEqual({
      home: "Chelsea",
      away: "Arsenal",
    });
  });

  it("only opens the board on explicit requests and recognizes distinct game counts", async () => {
    const board = await classifyMessage("show analysis board");
    const boardWithMe = await classifyMessage("show me the analysis board");
    const slate = await classifyMessage("3 high-probability games tonight");
    expect(board).toMatchObject({ intent: "show_board", openBoard: true });
    expect(boardWithMe).toMatchObject({ intent: "show_board", openBoard: true });
    expect(slate).toMatchObject({ intent: "best_plays", openBoard: false, limit: 3, distinctMatches: true });
    expect((await classifyMessage("best goal picks today")).targetMarket).toBe("Over/Under Goals");
    expect((await classifyMessage("check chelsea")).requestedTeam).toBe("chelsea");
    expect((await classifyMessage("GG tonight")).targetMarket).toBe("BTTS");
  });

  it("reuses fixture context for market follow-ups", async () => {
    const context = {
      lastMatchedFixture: {
        id: "follow-up-match",
        sport_key: "soccer_epl",
        commence_time: "2026-12-01T19:00:00Z",
        home_team: "Chelsea",
        away_team: "Arsenal",
      },
    };
    const result = await classifyMessage("what about total shots?", context);
    expect(result).toMatchObject({
      intent: "analyse_match",
      useContext: true,
      targetMarket: "Total Shots",
      limit: 1,
    });
    expect((await classifyMessage("for correct score", context)).targetMarket).toBe("Correct Score");
    expect((await classifyMessage("for goals", context)).targetMarket).toBe("Over/Under Goals");
  });

  it("derives complementary Poisson probabilities for total shots", () => {
    const probabilities = deriveShotMarketProbabilities(11, 12, 4, 4);
    expect(probabilities).toBeDefined();
    if (!probabilities) throw new Error("Expected valid shot probabilities.");
    expect(probabilities.totalShots[21.5].over + probabilities.totalShots[21.5].under).toBeCloseTo(1, 12);
    expect(probabilities?.totalShots[21.5].over).toBeGreaterThan(probabilities?.totalShots[25.5].over ?? 0);
    expect(deriveShotMarketProbabilities(-1, 10, 4, 3)).toBeUndefined();
  });

  it("ranks only one highest-probability pick per distinct fixture", () => {
    const picks: Pick[] = [
      { match: "A vs B", market: "1X2", selection: "A", modelProb: 0.6, bookOdds: null, fairProb: null, edge: null, ev: null, confidence: "low", dataQuality: "model_only", justification: "" },
      { match: "A vs B", market: "BTTS", selection: "Yes", modelProb: 0.7, bookOdds: null, fairProb: null, edge: null, ev: null, confidence: "low", dataQuality: "model_only", justification: "" },
      { match: "C vs D", market: "1X2", selection: "C", modelProb: 0.5, bookOdds: null, fairProb: null, edge: null, ev: null, confidence: "low", dataQuality: "model_only", justification: "" },
    ];
    const ranked = rankPicks(picks, { limit: 2, sortBy: "probability", distinctMatches: true });
    expect(ranked.map((pick) => pick.selection)).toEqual(["Yes", "C"]);
  });

  it("reads completed ESPN match shot data and averages real summary values", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Accept: "application/json" });
      return new Response(JSON.stringify({
        boxscore: {
          teams: [{
            team: { displayName: "Sample United" },
            statistics: [
              { name: "totalShots", value: 14 },
              { name: "shotsOnTarget", value: 6 },
            ],
          }],
        },
      }), { status: 200 });
    });
    const scoreboard = {
      events: [{
        id: "shot-summary-event",
        date: "2026-11-25T19:00Z",
        status: { type: { completed: true, state: "post" } },
        competitions: [{
          competitors: [
            { homeAway: "home", team: { displayName: "Sample United" } },
            { homeAway: "away", team: { displayName: "Other FC" } },
          ],
        }],
      }],
    };
    await expect(getEspnTeamShotAverages("test.league", "Sample United", scoreboard)).resolves.toEqual({
      totalShots: 14,
      shotsOnTarget: 6,
      games: 1,
    });
  });

  it("ranks priced model picks and flags short prices", async () => {
    vi.stubEnv("FOOTBALL_API_KEY", "");
    vi.stubEnv("API_FOOTBALL_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      const isStandings = url.includes("/standings");
      const payload = isStandings
        ? {
            children: [{
              standings: {
                entries: ["Chelsea", "Arsenal"].map((team, index) => ({
                  team: { displayName: team },
                  stats: [
                    { name: "gamesPlayed", value: 10 },
                    { name: "wins", value: index === 0 ? 7 : 5 },
                    { name: "ties", value: 2 },
                    { name: "losses", value: index === 0 ? 1 : 3 },
                    { name: "pointsFor", value: index === 0 ? 22 : 16 },
                    { name: "pointsAgainst", value: index === 0 ? 9 : 12 },
                    { name: "rank", value: index + 1 },
                    { name: "form", displayValue: "W-D-W-L-W" },
                  ],
                })),
              },
            }],
          }
        : { events: [] };
      return new Response(JSON.stringify(payload), { status: 200 });
    });

    const fixture: OddsFixture = {
      id: "ranked-fixture",
      sport_key: "soccer_epl",
      commence_time: "2026-12-01T19:00:00Z",
      home_team: "Chelsea",
      away_team: "Arsenal",
      bookmakers: [{
        key: "test-book",
        title: "Test Book",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Chelsea", price: 1.1 },
              { name: "Draw", price: 4.2 },
              { name: "Arsenal", price: 7 },
            ],
          },
          {
            key: "totals",
            outcomes: [
              { name: "Over", point: 2.5, price: 2 },
              { name: "Under", point: 2.5, price: 1.9 },
            ],
          },
        ],
      }],
    };
    const picks = await analyseFixtures([fixture], { limit: 20 });
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.some((pick) => pick.bookOdds !== null)).toBe(true);
    expect(picks.some((pick) => pick.lowValue)).toBe(true);
    expect(picks.some((pick) => pick.market === "Correct Score")).toBe(true);
    expect(picks.filter((pick) => pick.market === "Correct Score")).toHaveLength(3);
    expect(picks.some((pick) => pick.market === "Over/Under Goals" && pick.selection === "Over 1.5 Goals")).toBe(true);
    expect(picks.some((pick) => pick.market === "Over/Under Goals" && pick.selection === "Under 3.5 Goals")).toBe(true);
    expect(picks.some((pick) => pick.market === "Total Shots")).toBe(false);
    expect(picks.map((pick) => pick.ev ?? -Infinity)).toEqual(
      [...picks].map((pick) => pick.ev ?? -Infinity).sort((a, b) => b - a),
    );
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

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});
