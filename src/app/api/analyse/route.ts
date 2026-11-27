import { NextRequest, NextResponse } from "next/server";
import { extractedBetSchema } from "@/lib/stats/types";
import { analyseFixtures, rankPicks, type FixtureWithOdds } from "@/lib/model/analyseFixtures";
import { getSportKeyForLeague, getUpcomingOddsFixtures, findOddsFixture } from "@/lib/stats/oddsApi";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { bets?: unknown };
    const bets = extractedBetSchema.array().parse(body.bets ?? []);
    if (bets.length === 0) {
      return NextResponse.json({ picks: [], message: "No confirmed bets to analyse." });
    }

    const availableFixtures = await getUpcomingOddsFixtures();
    const fixturesWithOdds: FixtureWithOdds[] = bets.map((bet, index) => {
      const fixture = findOddsFixture(availableFixtures, bet.home, bet.away);
      const selectedFixture: FixtureWithOdds = fixture ?? {
        id: `confirmed-screenshot-${index}`,
        sport_key: getSportKeyForLeague(bet.league),
        commence_time: bet.date ?? new Date().toISOString(),
        home_team: bet.home,
        away_team: bet.away,
        bookmakers: [],
      };
      return { ...selectedFixture, confirmedBets: [bet] };
    });

    const boardPicks = await analyseFixtures(fixturesWithOdds, {
      limit: 300,
      sortBy: "probability",
      includeExplanation: false,
    });
    const picks = rankPicks(boardPicks, { limit: 6, sortBy: "ev" });
    return NextResponse.json({
      picks,
      boardPicks,
      message: picks.length ? `Ranked ${picks.length} confirmed picks.` : "No confirmed bets could be analysed.",
      fixtureRefs: [...new Map(fixturesWithOdds.map((fixture) => [fixture.id, {
        id: fixture.id,
        sport_key: fixture.sport_key,
        commence_time: fixture.commence_time,
        home_team: fixture.home_team,
        away_team: fixture.away_team,
      }])).values()].slice(0, 8),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not complete analysis.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
