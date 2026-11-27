import { NextRequest, NextResponse } from "next/server";
import { extractedBetSchema, type MatchContext, type Pick, type TeamStats } from "@/lib/stats/types";
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
import { deriveMarketProbabilities } from "@/lib/model/markets";
import { calculateValue } from "@/lib/model/value";
import { explainPicks } from "@/lib/ai/explain";
import {
  findOddsFixture,
  getMarketOdds,
  getSportKeyForLeague,
  getUpcomingOddsFixtures,
} from "@/lib/stats/oddsApi";
import { teamNameSimilarity } from "@/lib/stats/fuzzy";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

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

async function getApiFootballFallback(
  name: string,
  leagueId: number,
  season: number,
): Promise<TeamStats | undefined> {
  if (!process.env.FOOTBALL_API_KEY && !process.env.API_FOOTBALL_KEY) return undefined;
  try {
    const search = await searchTeams(name);
    const team = search.response
      .map((item) => item.team)
      .sort((a, b) => teamNameSimilarity(name, b.name) - teamNameSimilarity(name, a.name))[0];
    if (!team || teamNameSimilarity(name, team.name) < 0.62) return undefined;

    const result = await getTeamStatistics(team.id, leagueId, season);
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

function selectionProbability(
  market: string,
  selection: string,
  homeName: string,
  awayName: string,
  markets: ReturnType<typeof deriveMarketProbabilities>,
): number {
  const marketText = market.toLowerCase();
  const pickText = selection.toLowerCase();
  if (marketText.includes("over") || marketText.includes("under") || /total/i.test(marketText)) {
    const line = Number((selection.match(/\d(?:\.\d)?/) ?? market.match(/\d(?:\.\d)?/))?.[0] ?? 2.5);
    return pickText.includes("under")
      ? markets.under[line] ?? 0
      : markets.over[line] ?? 0;
  }
  if (marketText.includes("btts") || marketText.includes("both teams")) {
    return pickText.includes("no") ? markets.bttsNo : markets.bttsYes;
  }
  if (pickText === "draw" || pickText === "x") return markets.draw;
  if (
    pickText === "1" ||
    teamNameSimilarity(selection, homeName) > teamNameSimilarity(selection, awayName)
  ) return markets.home;
  if (
    pickText === "2" ||
    teamNameSimilarity(selection, awayName) > teamNameSimilarity(selection, homeName)
  ) return markets.away;
  return markets.draw;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { bets?: unknown };
    const bets = extractedBetSchema.array().parse(body.bets ?? []);
    if (bets.length === 0) {
      return NextResponse.json({ picks: [], message: "No confirmed bets to analyse." });
    }

    const allFixtures = await getUpcomingOddsFixtures();
    const picks: Pick[] = [];
    for (const bet of bets) {
      const fixture = findOddsFixture(allFixtures, bet.home, bet.away);
      const sportKey = fixture?.sport_key ?? getSportKeyForLeague(bet.league);
      const espnCode = ESPN_LEAGUE_CODES[sportKey] ?? "eng.1";
      const leagueData = await getEspnLeagueData(espnCode);
      const leagueAvgGoals = getLeagueAverageGoals(leagueData.standings);
      const fixtureHome = fixture?.home_team ?? bet.home;
      const fixtureAway = fixture?.away_team ?? bet.away;

      let homeStats = getEspnTeamStats(leagueData.standings, fixtureHome, leagueData.scoreboard);
      let awayStats = getEspnTeamStats(leagueData.standings, fixtureAway, leagueData.scoreboard);
      let homeSource: "espn" | "football" | "baseline" = homeStats ? "espn" : "baseline";
      let awaySource: "espn" | "football" | "baseline" = awayStats ? "espn" : "baseline";
      if (!homeStats || !awayStats) {
        const [homeFallback, awayFallback] = await Promise.allSettled([
          homeStats ? Promise.resolve(undefined) : getApiFootballFallback(fixtureHome, leagueIdForSport(sportKey), new Date().getFullYear() - 1),
          awayStats ? Promise.resolve(undefined) : getApiFootballFallback(fixtureAway, leagueIdForSport(sportKey), new Date().getFullYear() - 1),
        ]);
        if (!homeStats && homeFallback.status === "fulfilled" && homeFallback.value) {
          homeStats = homeFallback.value;
          homeSource = "football";
        }
        if (!awayStats && awayFallback.status === "fulfilled" && awayFallback.value) {
          awayStats = awayFallback.value;
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
        homeName: fixtureHome,
        awayName: fixtureAway,
      };
      const markets = deriveMarketProbabilities(context);
      const modelProb = selectionProbability(
        bet.market,
        bet.selection,
        fixtureHome,
        fixtureAway,
        markets,
      );
      const oddsApiPrice = getMarketOdds(fixture, bet.selection, `${bet.market} ${bet.selection}`);
      const bookOdds = oddsApiPrice ?? bet.odds ?? null;
      const value = bookOdds === null
        ? null
        : calculateValue(modelProb, bookOdds, [bookOdds, bookOdds]);
      if (bookOdds !== null && bookOdds < 1.25) continue;

      const dataQuality = homeSource === "baseline" || awaySource === "baseline"
        ? "limited"
        : homeSource === "espn" && awaySource === "espn" &&
            homeStats.form.length >= 5 && awayStats.form.length >= 5
          ? "complete"
          : "partial";
      picks.push({
        match: `${fixtureHome} vs ${fixtureAway}`,
        market: bet.market,
        selection: bet.selection,
        modelProb,
        bookOdds,
        fairProb: value?.fairProb ?? null,
        edge: value?.edge ?? null,
        ev: value?.ev ?? null,
        confidence: dataQuality === "complete" ? "high" : dataQuality === "partial" ? "medium" : "low",
        dataQuality,
        justification: bookOdds === null
          ? `Model-only estimate: ${(modelProb * 100).toFixed(1)}% probability. No odds were available. Data quality: ${dataQuality}.`
          : `Model probability ${(modelProb * 100).toFixed(1)}%; fair probability ${((value?.fairProb ?? 0) * 100).toFixed(1)}%. Data quality: ${dataQuality}.`,
      });
    }

    picks.sort((a, b) => (b.ev ?? -Infinity) - (a.ev ?? -Infinity));
    const explanations = await explainPicks(
      picks,
      "Computed from ESPN live standings, API-Football fallback where available, and league-average baselines for missing teams.",
    );
    const explained = picks.map((pick, index) => ({
      ...pick,
      justification: explanations[index] ?? pick.justification,
    }));
    return NextResponse.json({ picks: explained });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not complete analysis.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
