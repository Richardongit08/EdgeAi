import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyIntent, extractPickLimit, extractRequestedMatch } from "../lib/ai/intent";
import { analyseFixtureCandidates, analyseFixtures } from "../lib/model/analyseFixtures";
import { buildScoreMatrix } from "../lib/model/poisson";
import { deriveMarketProbabilities, matrixSum } from "../lib/model/markets";
import { calculateValue, removeMargin } from "../lib/model/value";
import { fuzzyTeamMatch, levenshtein } from "../lib/stats/fuzzy";
import { getEspnTeamStats, leagueAverageTeamStats } from "../lib/stats/espnStats";
import {
  findOddsFixture,
  getMarketOdds,
  getUpcomingOddsFixtures,
  type OddsFixture,
} from "../lib/stats/oddsApi";
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
    expect(markets.over[2.5] + markets.under[2.5]).toBeCloseTo(1, 8);
  });

  it("uses calibrated expected goals whenever team statistics need a baseline", () => {
    const baseline = leagueAverageTeamStats();
    const markets = deriveMarketProbabilities({
      homeName: "Home",
      awayName: "Away",
      leagueAvgGoals: 2.65,
      h2h: [],
      home: baseline,
      away: {
        form: [],
        goalsForHome: 10,
        goalsAgainstHome: 8,
        goalsForAway: 10,
        goalsAgainstAway: 8,
        injuries: [],
      },
    });

    expect(markets.lambdaHome).toBe(1.38);
    expect(markets.lambdaAway).toBe(1.14);
    expect(markets.over[1.5]).toBeGreaterThanOrEqual(0.65);
    expect(markets.over[1.5]).toBeLessThanOrEqual(0.82);
    expect(markets.doubleChance.homeOrDraw).toBeGreaterThanOrEqual(0.65);
    expect(markets.doubleChance.homeOrDraw).toBeLessThanOrEqual(0.82);
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

  it("extracts direct decimal prices and derives Double Chance prices from h2h", () => {
    const fixture: OddsFixture = {
      id: "prices-fixture",
      sport_key: "soccer_epl",
      commence_time: "2026-12-01T19:00:00Z",
      home_team: "Arsenal",
      away_team: "Chelsea",
      bookmakers: [{
        key: "test-book",
        title: "Test Book",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Arsenal", price: 2.1 },
              { name: "Draw", price: 3.2 },
              { name: "Chelsea", price: 3.6 },
            ],
          },
          {
            key: "totals",
            outcomes: [
              { name: "Over", point: 2.5, price: 2.05 },
              { name: "Under", point: 2.5, price: 1.8 },
            ],
          },
          {
            key: "spreads",
            outcomes: [
              { name: "Arsenal", point: -0.5, price: 2.0 },
              { name: "Chelsea", point: 0.5, price: 1.9 },
            ],
          },
        ],
      }],
    };

    expect(getMarketOdds(fixture, "Home", "h2h")).toBe(2.1);
    expect(getMarketOdds(fixture, "Over 2.5", "Goals Over/Under 2.5")).toBe(2.05);
    expect(getMarketOdds(fixture, "Over 3.5", "Totals")).toBeNull();
    expect(getMarketOdds(fixture, "Arsenal -0.5", "Asian Handicap")).toBe(2.0);
    expect(getMarketOdds(fixture, "1X", "Double Chance")).toBeCloseTo(1 / (1 / 2.1 + 1 / 3.2), 8);
  });

  it("falls back to ESPN fixtures when The Odds API is quota-limited and model-prices the picks", async () => {
    vi.stubEnv("ODDS_API_KEY", "quota-limited-key");
    const kickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const event = {
      id: "espn-epl-fixture",
      date: kickoff,
      competitions: [{
        competitors: [
          { homeAway: "home", team: { displayName: "Chelsea" } },
          { homeAway: "away", team: { displayName: "Arsenal" } },
        ],
      }],
    };
    const requestedUrls: URL[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      requestedUrls.push(url);
      if (url.hostname === "api.the-odds-api.com") {
        return new Response("{}", { status: 429 });
      }
      if (url.hostname === "site.api.espn.com") {
        return url.pathname.endsWith("/scoreboard")
          ? new Response(JSON.stringify({
              events: url.pathname.includes("/eng.1/") ? [event] : [],
            }), { status: 200 })
          : new Response(JSON.stringify({ children: [] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    const fixtures = await getUpcomingOddsFixtures();
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({
      sport_key: "soccer_epl",
      home_team: "Chelsea",
      away_team: "Arsenal",
      modelPriced: true,
      bookmakers: [],
    });
    const queriedLeagues = new Set(requestedUrls
      .filter((url) => url.hostname === "site.api.espn.com" && url.pathname.endsWith("/scoreboard"))
      .map((url) => url.pathname.split("/").slice(-2, -1)[0]));
    expect(queriedLeagues).toEqual(new Set([
      "eng.1",
      "esp.1",
      "ita.1",
      "ger.1",
      "fra.1",
      "uefa.champions",
      "uefa.europa",
      "eng.2",
      "ned.1",
      "por.1",
    ]));

    const picks = await analyseFixtures(fixtures, {
      limit: 50,
      singleBestPerMatch: true,
    });
    expect(picks).toHaveLength(1);
    expect(picks[0].bookOdds).toBeGreaterThan(1);
    expect(Number.isFinite(picks[0].bookOdds)).toBe(true);

    const candidates = await analyseFixtureCandidates(fixtures);
    const pricedCandidates = candidates.filter((pick) => pick.bookOdds !== null);
    expect(candidates.every((pick) => pick.modelProb <= 0.9)).toBe(true);
    expect(candidates.every((pick) => pick.market !== "Total Shots")).toBe(true);
    expect(pricedCandidates.every((pick) =>
      pick.bookOdds === Math.max(1.12, Number((1 / (pick.modelProb * 1.06)).toFixed(2))),
    )).toBe(true);
    expect(new Set(pricedCandidates.map((pick) => pick.bookOdds)).size).toBeGreaterThan(1);

    vi.stubEnv("ODDS_API_KEY", "");
    expect(await getUpcomingOddsFixtures()).toHaveLength(1);

    const liveOddsFixture: OddsFixture = {
      id: "live-api-fixture",
      sport_key: "soccer_epl",
      commence_time: kickoff,
      home_team: "Chelsea",
      away_team: "Arsenal",
      bookmakers: [],
    };
    const liveApiUrls: string[] = [];
    vi.stubEnv("ODDS_API_KEY", "working-key");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      liveApiUrls.push(url.toString());
      if (url.hostname === "api.the-odds-api.com") {
        return new Response(JSON.stringify(
          url.pathname.includes("/soccer_epl/") ? [liveOddsFixture] : [],
        ), { status: 200 });
      }
      throw new Error(`Unexpected ESPN fallback request: ${url}`);
    });
    expect(await getUpcomingOddsFixtures()).toEqual([liveOddsFixture]);
    expect(liveApiUrls.every((url) => url.includes("api.the-odds-api.com"))).toBe(true);
  });

  it("recognizes best-play phrasing and requested match limits", async () => {
    expect(await classifyIntent("Give me 4 games today")).toBe("best_plays");
    expect(await classifyIntent("What are the safest picks?")).toBe("best_plays");
    expect(extractPickLimit("Show me 12 picks")).toBe(12);
    expect(extractPickLimit("6 correct score games")).toBe(6);
    expect(extractPickLimit("5 over/under games")).toBe(5);
    expect(extractPickLimit("3 total shots games")).toBe(3);
    expect(extractPickLimit("5 double chance games")).toBe(5);
    expect(await classifyIntent("4 btts games")).toBe("best_plays");
    expect(await classifyIntent("5 double chance games")).toBe("best_plays");
    expect(extractRequestedMatch("Please analyse Nottingham Forest vs Chelsea tonight")).toEqual({
      home: "Nottingham Forest",
      away: "Chelsea",
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
    expect(picks.some((pick) => pick.market === "Double Chance" && pick.bookOdds !== null)).toBe(true);
    expect(picks.some((pick) => pick.lowValue)).toBe(true);
    expect(picks.map((pick) => pick.ev ?? -Infinity)).toEqual(
      [...picks].map((pick) => pick.ev ?? -Infinity).sort((a, b) => b - a),
    );

    const confirmedPicks = await analyseFixtures([{
      ...fixture,
      confirmedBets: [{ home: "Chelsea", away: "Arsenal", market: "h2h", selection: "Chelsea" }],
    }], { limit: 50 });
    const confirmedPick = confirmedPicks.find((pick) =>
      pick.market === "h2h" && pick.selection === "Chelsea",
    );
    expect(confirmedPick).toBeDefined();
    if (!confirmedPick) throw new Error("Expected confirmed bet pick to be analyzed.");
    expect(confirmedPick.modelProb).toBeGreaterThanOrEqual(0.56);
    expect(confirmedPick.modelProb).toBeLessThanOrEqual(0.83);
    expect(confirmedPick.bookOdds).toBe(
      Math.max(1.18, Number((1 / (confirmedPick.modelProb * 1.06)).toFixed(2))),
    );
    expect(confirmedPick.ev).not.toBeNull();

    const confirmedWithOdds = await analyseFixtures([{
      ...fixture,
      confirmedBets: [{
        home: "Chelsea",
        away: "Arsenal",
        market: "h2h",
        selection: "Chelsea",
        odds: 2,
      }],
    }], { limit: 50 });
    const bookmakerPick = confirmedWithOdds.find((pick) =>
      pick.market === "h2h" && pick.selection === "Chelsea",
    );
    const modelPick = picks.find((pick) =>
      pick.market === "1X2" && pick.selection === "Chelsea",
    );
    expect(modelPick).toBeDefined();
    if (!modelPick) throw new Error("Expected model pick to compare with bookmaker odds.");
    expect(bookmakerPick?.modelProb).toBeCloseTo((modelPick.modelProb * 0.7) + 0.15);
    expect(bookmakerPick?.bookOdds).toBe(2);
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
