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
  getEspnTeamShotAverages,
  getLeagueAverageGoals,
  leagueAverageTeamStats,
  type TeamShotAverages,
} from "@/lib/stats/espnStats";
import { deriveShotMarketProbabilities } from "@/lib/model/shots";
import { teamNameSimilarity } from "@/lib/stats/fuzzy";
import {
  getSportKeyForLeague,
  type OddsFixture,
} from "@/lib/stats/oddsApi";
import type { Confidence, ExtractedBet, MatchContext, Pick, TeamStats } from "@/lib/stats/types";

export type FixtureWithOdds = OddsFixture & { confirmedBets?: ExtractedBet[] };

export interface AnalyseFixturesOptions {
  limit?: number;
  sortBy?: "probability" | "ev";
  distinctMatches?: boolean;
  targetMarket?: string;
  selectionFilter?: string;
  includeExplanation?: boolean;
}

export function rankPicks(picks: Pick[], options: AnalyseFixturesOptions = {}): Pick[] {
  const limit = Math.max(1, Math.min(300, Math.floor(options.limit ?? 6)));
  let candidates = [...picks];
  if (options.targetMarket && options.targetMarket !== "all") {
    candidates = candidates.filter((pick) => pick.market === options.targetMarket);
  }
  if (options.selectionFilter) {
    const filter = options.selectionFilter.toLowerCase();
    candidates = candidates.filter((pick) => {
      const selection = pick.selection.toLowerCase();
      return filter.startsWith("exclude:")
        ? !selection.includes(filter.slice("exclude:".length))
        : selection.includes(filter);
    });
  }
  const sortBy = options.sortBy ?? "ev";
  candidates.sort(sortBy === "probability"
    ? (a, b) => b.modelProb - a.modelProb
    : (a, b) => (b.ev ?? -Infinity) - (a.ev ?? -Infinity));
  if (options.distinctMatches) {
    const selected = new Set<string>();
    candidates = candidates.filter((pick) => {
      if (selected.has(pick.match)) return false;
      selected.add(pick.match);
      return true;
    });
  }
  return candidates.slice(0, limit);
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
  if (normalizedMarket === "correct score") {
    return probabilities.topCorrectScores.find((score) => score.score === normalizedSelection)?.probability;
  }
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
      const outcomes = market.outcomes.filter((outcome) => {
        if (!Number.isFinite(outcome.price) || outcome.price <= 1) return false;
        if (market.key !== "totals") return true;
        const line = outcome.point ?? Number(outcome.name.match(/\d+(?:\.\d+)?/)?.[0]);
        return [1.5, 2.5, 3.5].includes(line);
      });
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
            : market.key === "totals" ? "Over/Under Goals"
              : market.key === "spreads" ? "Asian Handicap"
                : market.key === "btts" ? "BTTS" : market.key;
          candidates.push({
            market: marketLabel,
            selection: market.key === "totals"
              ? `${outcome.name.match(/over|under/i)?.[0] ?? outcome.name} ${point} Goals`
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
    { market: "Double Chance", selection: `${home} or Draw (1X)`, modelProb: probabilities.doubleChance.homeOrDraw },
    { market: "Double Chance", selection: `${home} or ${away} (12)`, modelProb: probabilities.doubleChance.homeOrAway },
    { market: "Double Chance", selection: `Draw or ${away} (X2)`, modelProb: probabilities.doubleChance.drawOrAway },
    { market: "BTTS", selection: "Yes", modelProb: probabilities.bttsYes },
    { market: "BTTS", selection: "No", modelProb: probabilities.bttsNo },
    ...probabilities.topCorrectScores.map(({ score, probability }) => ({
      market: "Correct Score",
      selection: score,
      modelProb: probability,
    })),
    { market: "Over/Under Goals", selection: "Over 1.5 Goals", modelProb: probabilities.over[1.5] },
    { market: "Over/Under Goals", selection: "Under 2.5 Goals", modelProb: probabilities.under[2.5] },
    { market: "Over/Under Goals", selection: "Over 2.5 Goals", modelProb: probabilities.over[2.5] },
    { market: "Over/Under Goals", selection: "Under 3.5 Goals", modelProb: probabilities.under[3.5] },
  ];
  return candidates;
}

function shotCandidates(
  fixture: OddsFixture,
  home: TeamShotAverages | undefined,
  away: TeamShotAverages | undefined,
): Array<{
  selection: string;
  modelProb: number;
  expectedTotalShots: number;
  expectedShotsOnTarget: number;
  shotSampleSize: number;
}> {
  if (!home || !away) return [];
  const probabilities = deriveShotMarketProbabilities(
    home.totalShots,
    away.totalShots,
    home.shotsOnTarget,
    away.shotsOnTarget,
  );
  if (!probabilities) return [];
  const candidates: Array<{
    selection: string;
    modelProb: number;
    expectedTotalShots: number;
    expectedShotsOnTarget: number;
    shotSampleSize: number;
  }> = [];
  for (const line of [21.5, 23.5, 25.5]) {
    candidates.push(
      {
        selection: `Over ${line} Total Match Shots`,
        modelProb: probabilities.totalShots[line].over,
        expectedTotalShots: probabilities.expectedTotalShots,
        expectedShotsOnTarget: probabilities.expectedShotsOnTarget,
        shotSampleSize: Math.min(home.games, away.games),
      },
      {
        selection: `Under ${line} Total Match Shots`,
        modelProb: probabilities.totalShots[line].under,
        expectedTotalShots: probabilities.expectedTotalShots,
        expectedShotsOnTarget: probabilities.expectedShotsOnTarget,
        shotSampleSize: Math.min(home.games, away.games),
      },
    );
  }
  candidates.push(
    {
      selection: "Over 7.5 Shots on Target",
      modelProb: probabilities.shotsOnTarget[7.5].over,
      expectedTotalShots: probabilities.expectedTotalShots,
      expectedShotsOnTarget: probabilities.expectedShotsOnTarget,
      shotSampleSize: Math.min(home.games, away.games),
    },
    {
      selection: "Under 7.5 Shots on Target",
      modelProb: probabilities.shotsOnTarget[7.5].under,
      expectedTotalShots: probabilities.expectedTotalShots,
      expectedShotsOnTarget: probabilities.expectedShotsOnTarget,
      shotSampleSize: Math.min(home.games, away.games),
    },
  );
  return candidates.map((candidate) => ({ ...candidate, market: "Total Shots" }));
}

function makePick(
  fixture: OddsFixture,
  market: string,
  selection: string,
  modelProb: number,
  stats: {
    lambdaHome: number;
    lambdaAway: number;
    dataQuality: Pick["dataQuality"];
    expectedTotalShots?: number;
    expectedShotsOnTarget?: number;
    shotSampleSize?: number;
  },
  odds?: { price: number; fairProb: number },
): Pick {
  const fairProb = odds?.fairProb ?? null;
  const edge = fairProb === null ? null : modelProb - fairProb;
  const ev = odds ? modelProb * odds.price - 1 : null;
  const quality: Pick["dataQuality"] = stats.expectedTotalShots !== undefined && (stats.shotSampleSize ?? 0) < 3
    ? "partial"
    : odds ? stats.dataQuality : stats.dataQuality === "limited" ? "limited" : "model_only";
  const priceExplanation = odds
    ? `The available price of ${odds.price.toFixed(2)} gives a fair probability of ${(fairProb! * 100).toFixed(1)}% and model expected value of ${(ev! * 100).toFixed(1)}%.`
    : "No bookmaker price is available for this market, so value and edge cannot be calculated.";
  const estimateText = market === "Total Shots"
    ? `The Poisson shot model estimates ${stats.expectedTotalShots?.toFixed(1)} total shots and ${stats.expectedShotsOnTarget?.toFixed(1)} shots on target.`
    : `The Poisson goal model estimates ${(modelProb * 100).toFixed(1)}% probability for ${selection}, with expected goals of ${stats.lambdaHome.toFixed(2)} home and ${stats.lambdaAway.toFixed(2)} away.`;
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
    justification: `${estimateText} ${priceExplanation} Data quality is ${quality}.`,
  };
}

export async function analyseFixtures(
  fixturesWithOdds: FixtureWithOdds[],
  options: AnalyseFixturesOptions = {},
): Promise<Pick[]> {
  if (fixturesWithOdds.length === 0) return [];
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
    const [homeShots, awayShots] = data
      ? await Promise.all([
          getEspnTeamShotAverages(espnCode, fixture.home_team, data.scoreboard),
          getEspnTeamShotAverages(espnCode, fixture.away_team, data.scoreboard),
        ])
      : [undefined, undefined];
    if (homeStats && homeShots) {
      homeStats = {
        ...homeStats,
        totalShots: homeShots.totalShots,
        shotsOnTarget: homeShots.shotsOnTarget,
        shotSampleSize: homeShots.games,
      };
    }
    if (awayStats && awayShots) {
      awayStats = {
        ...awayStats,
        totalShots: awayShots.totalShots,
        shotsOnTarget: awayShots.shotsOnTarget,
        shotSampleSize: awayShots.games,
      };
    }
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
      ...shotCandidates(fixture, homeShots, awayShots).map((candidate) =>
        makePick(fixture, "Total Shots", candidate.selection, candidate.modelProb, {
          ...statsInfo,
          expectedTotalShots: candidate.expectedTotalShots,
          expectedShotsOnTarget: candidate.expectedShotsOnTarget,
          shotSampleSize: candidate.shotSampleSize,
        }),
      ),
      ...makeOddsCandidates(fixture, probabilities).map((candidate) =>
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
        if (modelProb === undefined || !bet.odds || bet.odds <= 1) return [];
        return [makePick(fixture, bet.market, bet.selection, modelProb, statsInfo, {
          price: bet.odds,
          fairProb: 1 / bet.odds,
        })];
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

  const ranked = rankPicks([...picksByKey.values()], options);
  const explanations = options.includeExplanation === false
    ? ranked.map((pick) => pick.justification)
    : await explainPicks(
        ranked,
        "Expected goals, match probabilities, bookmaker prices, vig-adjusted fair probabilities, edge, expected value, and data quality are included in each computed pick.",
      );
  return ranked.map((pick, index) => ({
    ...pick,
    justification: explanations[index] || pick.justification,
  }));
}
