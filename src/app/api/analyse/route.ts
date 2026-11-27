import { NextRequest, NextResponse } from "next/server";
import { extractedBetSchema, type MatchContext, type Pick, type TeamStats } from "@/lib/stats/types";
import { searchTeams, getTeamStatistics, getTeamFixtures, getHeadToHead, getInjuries } from "@/lib/stats/apiFootball";
import { deriveMarketProbabilities } from "@/lib/model/markets";
import { calculateValue } from "@/lib/model/value";
import { explainPicks } from "@/lib/ai/explain";
import { findOddsFixture, getLiveOdds, getMarketOdds } from "@/lib/stats/oddsApi";
import { getApiFootballOdds, getLeagueStandings } from "@/lib/stats/apiFootball";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface TeamStatResponse {
  response?: {
    fixtures?: { played?: { total?: number }; goals?: { for?: { total?: { home?: number; away?: number } }; against?: { total?: { home?: number; away?: number } } } };
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { bets?: unknown };
    const bets = extractedBetSchema.array().parse(body.bets ?? []);
    if (bets.length === 0) return NextResponse.json({ picks: [], message: "No confirmed bets to analyse." });

    const picks: Pick[] = [];
    const season = new Date().getFullYear();
    await Promise.allSettled([getLeagueStandings(39, season)]);

    for (const bet of bets.slice(0, 6)) {
      const teamSearches = await Promise.allSettled([
        searchTeams(bet.home),
        searchTeams(bet.away),
      ]);
      const homeSearch = teamSearches[0].status === "fulfilled" ? teamSearches[0].value : undefined;
      const awaySearch = teamSearches[1].status === "fulfilled" ? teamSearches[1].value : undefined;
      const homeTeam = homeSearch?.response[0]?.team;
      const awayTeam = awaySearch?.response[0]?.team;
      if (!homeTeam || !awayTeam) {
        continue;
      }

      const settled = await Promise.allSettled([
        getTeamStatistics(homeTeam.id, 39, season),
        getTeamStatistics(awayTeam.id, 39, season),
        getTeamFixtures(homeTeam.id, season),
        getTeamFixtures(awayTeam.id, season),
        getHeadToHead(homeTeam.id, awayTeam.id),
        getInjuries(homeTeam.id),
        getInjuries(awayTeam.id),
      ]);
      const getResult = <T>(index: number): T | undefined =>
        settled[index].status === "fulfilled" ? settled[index].value as T : undefined;
      const homeStats = getResult<{ response: unknown }>(0);
      const awayStats = getResult<{ response: unknown }>(1);
      const homeFixtures = getResult<{ response: Array<unknown> }>(2) ?? { response: [] };
      const awayFixtures = getResult<{ response: Array<unknown> }>(3) ?? { response: [] };
      const h2h = getResult<{ response: Array<unknown> }>(4) ?? { response: [] };
      const homeInjuries = getResult<{ response: Array<unknown> }>(5) ?? { response: [] };
      const awayInjuries = getResult<{ response: Array<unknown> }>(6) ?? { response: [] };

      const mapTeamStats = (raw: unknown, fixtures: { response: Array<unknown> }, injuries: { response: Array<unknown> }): TeamStats => {
        const response = (raw as TeamStatResponse).response;
        const forGoals = response?.fixtures?.goals?.for?.total;
        const againstGoals = response?.fixtures?.goals?.against?.total;
        return {
          form: fixtures.response.slice(0, 10).map(() => 1),
          goalsForHome: forGoals?.home ?? 0,
          goalsAgainstHome: againstGoals?.home ?? 0,
          goalsForAway: forGoals?.away ?? 0,
          goalsAgainstAway: againstGoals?.away ?? 0,
          injuries: injuries.response.map((item) => {
            const player = item as { player?: { name?: string } };
            return player.player?.name ?? "Unknown";
          }),
        };
      };

      const home = mapTeamStats(homeStats, homeFixtures, homeInjuries);
      const away = mapTeamStats(awayStats, awayFixtures, awayInjuries);
      const h2hData = h2h.response as Array<{ goals?: { home?: { total?: number }; away?: { total?: number } } }>;
      const context: MatchContext = {
        home,
        away,
        h2h: h2hData.map((match) => ({
          homeGoals: match.goals?.home?.total ?? 0,
          awayGoals: match.goals?.away?.total ?? 0,
        })),
        leagueAvgGoals: 2.65,
        homeName: homeTeam.name,
        awayName: awayTeam.name,
      };
      const markets = deriveMarketProbabilities(context);
      const marketText = bet.market.toLowerCase();
      let modelProb = 0;
      let marketOdds: number[] = [];
      if (marketText.includes("over") || marketText.includes("under")) {
        const line = Number(marketText.match(/(\d(?:\.\d)?)/)?.[1] ?? 2.5);
        if (marketText.includes("under")) {
          modelProb = markets.under[line] ?? 0;
        } else {
          modelProb = markets.over[line] ?? 0;
        }
      } else if (marketText.includes("btts")) {
        modelProb = bet.selection.toLowerCase().includes("no") ? markets.bttsNo : markets.bttsYes;
      } else if (/home|1/.test(bet.selection.toLowerCase())) {
        modelProb = markets.home;
      } else if (/away|2/.test(bet.selection.toLowerCase())) {
        modelProb = markets.away;
      } else {
        modelProb = markets.draw;
      }

      const leagueKey = /premier|england/i.test(bet.league ?? "")
        ? "soccer_epl"
        : /spain|la liga/i.test(bet.league ?? "")
          ? "soccer_spain_la_liga"
          : /italy|serie a/i.test(bet.league ?? "")
            ? "soccer_italy_serie_a"
            : "soccer_epl";
      const liveOdds = await getLiveOdds(leagueKey);
      const liveFixture = findOddsFixture(liveOdds, homeTeam.name, awayTeam.name);
      let bookOdds = getMarketOdds(liveFixture, bet.selection, bet.market);

      if (bookOdds === null) {
        const fixtureRecord = [...homeFixtures.response, ...awayFixtures.response].find((item) => {
          const fixture = item as { fixture?: { id?: number }; teams?: { home?: { name?: string }; away?: { name?: string } } };
          return fixture.teams?.home?.name === homeTeam.name || fixture.teams?.away?.name === awayTeam.name;
        }) as { fixture?: { id?: number } } | undefined;
        const fixtureId = fixtureRecord?.fixture?.id;
        if (fixtureId) {
          const apiOdds = await getApiFootballOdds(fixtureId);
          const oddsEntry = apiOdds.response.find((item) => typeof item === "object" && item !== null);
          const bookmaker = oddsEntry as {
            bookmakers?: Array<{ bets?: Array<{ values?: Array<{ value?: string; odd?: string }> }> }>;
          } | undefined;
          const firstValue = bookmaker?.bookmakers?.flatMap((bookmakerItem) =>
            bookmakerItem.bets?.flatMap((betItem) => betItem.values ?? []) ?? [],
          ).find((value) => value.value && value.odd);
          const parsedOdds = firstValue ? Number(firstValue.odd) : NaN;
          if (Number.isFinite(parsedOdds) && parsedOdds > 0) bookOdds = parsedOdds;
        }
      }

      const value = bookOdds === null
        ? null
        : calculateValue(modelProb, bookOdds, marketOdds.length > 0 ? marketOdds : [bookOdds, bookOdds]);
      if (bookOdds !== null && bookOdds < 1.25) continue;
      const confidence = home.form.length >= 10 && away.form.length >= 10 ? "high" : home.form.length > 0 ? "medium" : "low";
      picks.push({
        match: `${homeTeam.name} vs ${awayTeam.name}`,
        market: bet.market,
        selection: bet.selection,
        modelProb,
        bookOdds,
        fairProb: value?.fairProb ?? null,
        edge: value?.edge ?? null,
        ev: value?.ev ?? null,
        confidence,
        dataQuality: bookOdds === null
          ? "model_only"
          : home.form.length >= 5 && away.form.length >= 5 ? "complete" : "partial",
        justification: bookOdds === null
          ? `Model-only estimate: ${(modelProb * 100).toFixed(1)}% probability. Insufficient live odds data.`
          : `Model probability ${(modelProb * 100).toFixed(1)}%; fair probability ${((value?.fairProb ?? 0) * 100).toFixed(1)}%.`,
      });
    }

    picks.sort((a, b) => (b.ev ?? -Infinity) - (a.ev ?? -Infinity));
    const explanations = await explainPicks(picks, "Computed only from API-Football statistics and the probability model.");
    const explained = picks.map((pick, index) => ({ ...pick, justification: explanations[index] ?? pick.justification }));
    return NextResponse.json({ picks: explained });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not complete analysis.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
