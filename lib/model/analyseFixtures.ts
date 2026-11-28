import { explainPicks } from "@/lib/ai/explain";
import { deriveMarketProbabilities, type MarketProbabilities } from "@/lib/model/markets";
import { removeMargin } from "@/lib/model/value";
import {
  getTeamStatistics,
  searchTeams,
} from "@/lib/stats/apiFootball";
import {
  ESPN_LEAGUE_CODES,
  getEspnLeagueData,
  getEspnTeamStats,
  getLeagueAverageGoals,
  leagueAverageTeamStats,
} from "@/lib/stats/espnStats";
import { teamNameSimilarity } from "@/lib/stats/fuzzy";
import {
  getMarketOdds,
  getSportKeyForLeague,
  type OddsFixture,
} from "@/lib/stats/oddsApi";
import type { Confidence, ExtractedBet, MatchContext, Pick, TeamStats } from "@/lib/stats/types";

export type FixtureWithOdds = OddsFixture & { confirmedBets?: ExtractedBet[] };

export interface AnalyseFixturesOptions {
  limit?: number;
}

interface ApiFootballTeamStatsResponse {
  response?: {
    form?: string;
    fixtures?: {
      played?: { total?: number };
      goals?: {
        for?: { total?: { home?: number | string; away?: number | string } };
        against?: { total?: { home?: number | string; away?: number | string } };
      };
    };
  };
}

interface PricedOutcome {
  market: string;
  selection: string;
  modelProb: number;
  odds: number;
  fairProb: number;
}

function parseGoals(value: number | string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function apiFootballForm(form: string | undefined): number[] {
  return (form ?? "")
    .toUpperCase()
    .split("")
    .filter((result) => result === "W" || result === "D" || result === "L")
    .slice(-10)
    .map((result) => result === "W" ? 1 : result === "D" ? 0.5 : 0);
}

function leagueIdForSport(sportKey: string): number {
  const leagueIds: Record<string, number> = {
    soccer_epl: 39,
    soccer_germany_bundesliga: 78,
    soccer_italy_serie_a: 135,
    soccer_spain_la_liga: 140,
    soccer_france_ligue_one: 61,
    soccer_efl_champ: 40,
    soccer_uefa_champs_league: 2,
    soccer_uefa_europa_league: 3,
  };
  return leagueIds[sportKey] ?? 39;
}

async function getApiFootballTeamStats(
  name: string,
  leagueId: number,
): Promise<TeamStats | undefined> {
  if (!process.env.FOOTBALL_API_KEY && !process.env.API_FOOTBALL_KEY) return undefined;
  try {
    const search = await searchTeams(name);
    const team = search.response
      .map((item) => item.team)
      .sort((a, b) => teamNameSimilarity(name, b.name) - teamNameSimilarity(name, a.name))[0];
    if (!team || teamNameSimilarity(name, team.name) < 0.72) return undefined;

    const result = await getTeamStatistics(team.id, leagueId, new Date().getFullYear() - 1);
    const response = (result as ApiFootballTeamStatsResponse).response;
    const played = response?.fixtures?.played?.total ?? 0;
    if (played <= 0) return undefined;
    const goalsForHome = parseGoals(response?.fixtures?.goals?.for?.total?.home);
    const goalsForAway = parseGoals(response?.fixtures?.goals?.for?.total?.away);
    const goalsAgainstHome = parseGoals(response?.fixtures?.goals?.against?.total?.home);
    const goalsAgainstAway = parseGoals(response?.fixtures?.goals?.against?.total?.away);
    return {
      form: apiFootballForm(response?.form),
      sampleSize: Math.max(played / 2, 1),
      gamesPlayed: played,
      goalsFor: goalsForHome + goalsForAway,
      goalsAgainst: goalsAgainstHome + goalsAgainstAway,
      goalsForHome,
      goalsForAway,
      goalsAgainstHome,
      goalsAgainstAway,
      injuries: [],
    };
  } catch {
    return undefined;
  }
}

function modelProbability(
  market: string,
  selection: string,
  homeName: string,
  awayName: string,
  probabilities: MarketProbabilities,
  point?: number,
): number | undefined {
  const normalizedMarket = market.toLowerCase();
  const normalizedSelection = selection.toLowerCase();
  if (
    normalizedMarket === "h2h" ||
    normalizedMarket === "1x2" ||
    normalizedMarket.includes("match result") ||
    normalizedMarket.includes("match winner") ||
    normalizedMarket.includes("full time result")
  ) {
    if (/draw|tie/.test(normalizedSelection)) return probabilities.draw;
    if (/^(home|1)$/.test(normalizedSelection)) return probabilities.home;
    if (/^(away|2)$/.test(normalizedSelection)) return probabilities.away;
    const homeSimilarity = teamNameSimilarity(selection, homeName);
    const awaySimilarity = teamNameSimilarity(selection, awayName);
    if (homeSimilarity >= 0.55 && homeSimilarity > awaySimilarity) return probabilities.home;
    if (awaySimilarity >= 0.55 && awaySimilarity > homeSimilarity) return probabilities.away;
    if (normalizedSelection === "1") return probabilities.home;
    if (normalizedSelection === "x") return probabilities.draw;
    if (normalizedSelection === "2") return probabilities.away;
    return undefined;
  }

  if (normalizedMarket === "double_chance" || normalizedMarket.includes("double chance")) {
    if (/1x|home.*draw|draw.*home/.test(normalizedSelection)) return probabilities.doubleChance.homeOrDraw;
    if (/12|home.*away|away.*home/.test(normalizedSelection)) return probabilities.doubleChance.homeOrAway;
    if (/x2|draw.*away|away.*draw/.test(normalizedSelection)) return probabilities.doubleChance.drawOrAway;
    const hasDraw = /draw|tie/.test(normalizedSelection);
    const hasHome = teamNameSimilarity(selection, homeName) >= 0.55;
    const hasAway = teamNameSimilarity(selection, awayName) >= 0.55;
    if (hasHome && hasDraw) return probabilities.doubleChance.homeOrDraw;
    if (hasHome && hasAway) return probabilities.doubleChance.homeOrAway;
    if (hasAway && hasDraw) return probabilities.doubleChance.drawOrAway;
    return undefined;
  }

  if (normalizedMarket === "totals" || normalizedMarket.includes("over") || normalizedMarket.includes("under") || /total/i.test(normalizedMarket)) {
    const line = point ?? Number((selection.match(/\d+(?:\.\d+)?/) ?? market.match(/\d+(?:\.\d+)?/))?.[0]);
    if (!Number.isFinite(line)) return undefined;
    if (/over/i.test(normalizedSelection)) return probabilities.over[line];
    if (/under/i.test(normalizedSelection)) return probabilities.under[line];
    return undefined;
  }

  if (normalizedMarket === "btts" || normalizedMarket.includes("both teams")) {
    if (/no|false/i.test(normalizedSelection)) return probabilities.bttsNo;
    if (/yes|true/i.test(normalizedSelection)) return probabilities.bttsYes;
    return undefined;
  }

  if (normalizedMarket === "spreads" || normalizedMarket.includes("handicap") || normalizedMarket.includes("spread")) {
    const handicapPoint = point ?? Number(selection.match(/[+-]\s*\d+(?:\.\d+)?/)?.[0].replace(/\s/g, ""));
    if (!Number.isFinite(handicapPoint)) return undefined;
    const homeSimilarity = teamNameSimilarity(selection, homeName);
    const awaySimilarity = teamNameSimilarity(selection, awayName);
    if (homeSimilarity > awaySimilarity) return probabilities.homeHandicap[String(handicapPoint)];
    if (awaySimilarity > homeSimilarity) return probabilities.awayHandicap[String(handicapPoint)];
  }
  return undefined;
}

function makeOddsCandidates(
  fixture: OddsFixture,
  probabilities: MarketProbabilities,
): PricedOutcome[] {
  const candidates: PricedOutcome[] = [];
  for (const bookmaker of fixture.bookmakers ?? []) {
    for (const market of bookmaker.markets ?? []) {
      const outcomes = market.outcomes.filter((outcome) =>
        Number.isFinite(outcome.price) && outcome.price > 1,
      );
      if (outcomes.length === 0) continue;

      const groups = market.key === "totals"
        ? [...new Set(outcomes.map((outcome) => String(outcome.point ?? outcome.name.match(/\d+(?:\.\d+)?/)?.[0] ?? "")))]
          .map((point) => outcomes.filter((outcome) =>
            String(outcome.point ?? outcome.name.match(/\d+(?:\.\d+)?/)?.[0] ?? "") === point,
          ))
        : [outcomes];

      for (const group of groups) {
        const validGroup = group.filter((outcome) => {
          const selection = outcome.name;
          const point = outcome.point;
          return modelProbability(market.key, selection, fixture.home_team, fixture.away_team, probabilities, point) !== undefined;
        });
        if (validGroup.length === 0) continue;
        const groupOdds = validGroup.map((outcome) => outcome.price);
        const fairProbabilities = groupOdds.length > 1
          ? removeMargin(groupOdds, 0)
          : [1 / groupOdds[0]];
        validGroup.forEach((outcome, index) => {
          const modelProb = modelProbability(
            market.key,
            outcome.name,
            fixture.home_team,
            fixture.away_team,
            probabilities,
            outcome.point,
          );
          if (modelProb === undefined) return;
          const point = outcome.point ?? Number(outcome.name.match(/\d+(?:\.\d+)?/)?.[0]);
          const marketLabel = market.key === "h2h" ? "1X2"
            : market.key === "totals" ? `Goals Over/Under ${point}`.trim()
              : market.key === "spreads" ? "Asian Handicap"
                : market.key === "btts" ? "BTTS" : market.key;
          candidates.push({
            market: marketLabel,
            selection: market.key === "totals"
              ? `${outcome.name.match(/over|under/i)?.[0] ?? outcome.name} ${point}`
              : outcome.point === undefined ? outcome.name : `${outcome.name} ${outcome.point > 0 ? "+" : ""}${outcome.point}`,
            modelProb,
            odds: outcome.price,
            fairProb: fairProbabilities[index],
          });
        });
      }
    }
  }
  return candidates;
}

function modelOnlyCandidates(
  fixture: OddsFixture,
  probabilities: MarketProbabilities,
): Array<{ market: string; selection: string; modelProb: number }> {
  const home = fixture.home_team;
  const away = fixture.away_team;
  const candidates = [
    { market: "1X2", selection: home, modelProb: probabilities.home },
    { market: "1X2", selection: "Draw", modelProb: probabilities.draw },
    { market: "1X2", selection: away, modelProb: probabilities.away },
    { market: "Double Chance", selection: "1X", modelProb: probabilities.doubleChance.homeOrDraw },
    { market: "Double Chance", selection: "12", modelProb: probabilities.doubleChance.homeOrAway },
    { market: "Double Chance", selection: "X2", modelProb: probabilities.doubleChance.drawOrAway },
    { market: "BTTS", selection: "Yes", modelProb: probabilities.bttsYes },
    { market: "BTTS", selection: "No", modelProb: probabilities.bttsNo },
  ];
  for (const line of [1.5, 2.5]) {
    candidates.push(
      { market: `Goals Over/Under ${line}`, selection: `Over ${line}`, modelProb: probabilities.over[line] },
      { market: `Goals Over/Under ${line}`, selection: `Under ${line}`, modelProb: probabilities.under[line] },
    );
  }
  return candidates;
}

function makeDoubleChanceCandidates(
  fixture: OddsFixture,
  probabilities: MarketProbabilities,
): PricedOutcome[] {
  return [
    { selection: "1X", modelProb: probabilities.doubleChance.homeOrDraw },
    { selection: "12", modelProb: probabilities.doubleChance.homeOrAway },
    { selection: "X2", modelProb: probabilities.doubleChance.drawOrAway },
  ].flatMap(({ selection, modelProb }) => {
    const odds = getMarketOdds(fixture, selection, "Double Chance");
    return odds === null
      ? []
      : [{ market: "Double Chance", selection, modelProb, odds, fairProb: 1 / odds }];
  });
}

function makePick(
  fixture: OddsFixture,
  market: string,
  selection: string,
  modelProb: number,
  stats: { lambdaHome: number; lambdaAway: number; dataQuality: Pick["dataQuality"] },
  odds?: { price: number; fairProb: number },
): Pick {
  const fairProb = odds?.fairProb ?? null;
  const edge = fairProb === null ? null : modelProb - fairProb;
  const ev = odds ? modelProb * odds.price - 1 : null;
  const quality = odds ? stats.dataQuality : stats.dataQuality === "limited" ? "limited" : "model_only";
  const priceExplanation = odds
    ? `The available price of ${odds.price.toFixed(2)} gives a fair probability of ${(fairProb! * 100).toFixed(1)}% and model expected value of ${(ev! * 100).toFixed(1)}%.`
    : "No bookmaker price is available for this market, so value and edge cannot be calculated.";
  return {
    match: `${fixture.home_team} vs ${fixture.away_team}`,
    market,
    selection,
    modelProb,
    bookOdds: odds?.price ?? null,
    fairProb,
    edge,
    ev,
    confidence: quality === "complete" ? "high" as Confidence : quality === "partial" ? "medium" as Confidence : "low" as Confidence,
    dataQuality: quality,
    lowValue: odds !== undefined && odds.price < 1.25,
    justification: `The Poisson model estimates ${(modelProb * 100).toFixed(1)}% probability for ${selection}, with expected goals of ${stats.lambdaHome.toFixed(2)} home and ${stats.lambdaAway.toFixed(2)} away. ${priceExplanation} Data quality is ${stats.dataQuality}.`,
  };
}

export async function analyseFixtures(
  fixturesWithOdds: FixtureWithOdds[],
  options: AnalyseFixturesOptions = {},
): Promise<Pick[]> {
  if (fixturesWithOdds.length === 0) return [];
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 6)));
  const leagueCodes = [...new Set(fixturesWithOdds.map((fixture) =>
    ESPN_LEAGUE_CODES[fixture.sport_key] ?? ESPN_LEAGUE_CODES[getSportKeyForLeague(fixture.sport_key)] ?? "eng.1",
  ))];
  const leagueResults = await Promise.allSettled(
    leagueCodes.map(async (code) => [code, await getEspnLeagueData(code)] as const),
  );
  const leagueData = new Map(
    leagueResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
  );
  const picksByKey = new Map<string, Pick>();

  for (const fixture of fixturesWithOdds) {
    const espnCode = ESPN_LEAGUE_CODES[fixture.sport_key] ?? "eng.1";
    const data = leagueData.get(espnCode);
    const leagueAvgGoals = getLeagueAverageGoals(data?.standings);
    let homeStats = data ? getEspnTeamStats(data.standings, fixture.home_team, data.scoreboard) : undefined;
    let awayStats = data ? getEspnTeamStats(data.standings, fixture.away_team, data.scoreboard) : undefined;
    let homeSource: "espn" | "football" | "baseline" = homeStats ? "espn" : "baseline";
    let awaySource: "espn" | "football" | "baseline" = awayStats ? "espn" : "baseline";
    if (!homeStats || !awayStats) {
      const fallbacks = await Promise.allSettled([
        homeStats ? Promise.resolve(undefined) : getApiFootballTeamStats(fixture.home_team, leagueIdForSport(fixture.sport_key)),
        awayStats ? Promise.resolve(undefined) : getApiFootballTeamStats(fixture.away_team, leagueIdForSport(fixture.sport_key)),
      ]);
      if (!homeStats && fallbacks[0].status === "fulfilled" && fallbacks[0].value) {
        homeStats = fallbacks[0].value;
        homeSource = "football";
      }
      if (!awayStats && fallbacks[1].status === "fulfilled" && fallbacks[1].value) {
        awayStats = fallbacks[1].value;
        awaySource = "football";
      }
    }

    homeStats ??= leagueAverageTeamStats(leagueAvgGoals);
    awayStats ??= leagueAverageTeamStats(leagueAvgGoals);
    const context: MatchContext = {
      home: homeStats,
      away: awayStats,
      h2h: [],
      leagueAvgGoals,
      homeName: fixture.home_team,
      awayName: fixture.away_team,
    };
    const probabilities = deriveMarketProbabilities(context);
    const dataQuality: Pick["dataQuality"] = homeSource === "baseline" || awaySource === "baseline"
      ? "limited"
      : homeSource === "espn" && awaySource === "espn" &&
          homeStats.sampleSize !== undefined && homeStats.sampleSize >= 5 &&
          awayStats.sampleSize !== undefined && awayStats.sampleSize >= 5 &&
          homeStats.form.length >= 5 && awayStats.form.length >= 5
        ? "complete"
        : "partial";
    const statsInfo = {
      lambdaHome: probabilities.lambdaHome,
      lambdaAway: probabilities.lambdaAway,
      dataQuality,
    };
    const candidatePicks = [
      ...modelOnlyCandidates(fixture, probabilities).map((candidate) =>
        makePick(fixture, candidate.market, candidate.selection, candidate.modelProb, statsInfo),
      ),
      ...makeOddsCandidates(fixture, probabilities).map((candidate) =>
        makePick(fixture, candidate.market, candidate.selection, candidate.modelProb, statsInfo, {
          price: candidate.odds,
          fairProb: candidate.fairProb,
        }),
      ),
      ...makeDoubleChanceCandidates(fixture, probabilities).map((candidate) =>
        makePick(fixture, candidate.market, candidate.selection, candidate.modelProb, statsInfo, {
          price: candidate.odds,
          fairProb: candidate.fairProb,
        }),
      ),
      ...(fixture.confirmedBets ?? []).flatMap((bet) => {
        const modelProb = modelProbability(
          bet.market,
          bet.selection,
          fixture.home_team,
          fixture.away_team,
          probabilities,
        );
        if (modelProb === undefined) return [];
        return [makePick(
          fixture,
          bet.market,
          bet.selection,
          modelProb,
          statsInfo,
          bet.odds && bet.odds > 1 ? { price: bet.odds, fairProb: 1 / bet.odds } : undefined,
        )];
      }),
    ];

    for (const pick of candidatePicks) {
      const key = `${pick.match.toLowerCase()}|${pick.market.toLowerCase()}|${pick.selection.toLowerCase()}`;
      const existing = picksByKey.get(key);
      if (!existing || (pick.ev ?? -Infinity) > (existing.ev ?? -Infinity)) {
        picksByKey.set(key, pick);
      }
    }
  }

  const ranked = [...picksByKey.values()]
    .sort((a, b) => (b.ev ?? -Infinity) - (a.ev ?? -Infinity))
    .slice(0, limit);
  const explanations = await explainPicks(
    ranked,
    "Expected goals, match probabilities, bookmaker prices, vig-adjusted fair probabilities, edge, expected value, and data quality are included in each computed pick.",
  );
  return ranked.map((pick, index) => ({
    ...pick,
    justification: explanations[index] || pick.justification,
  }));
}
