import { NextRequest, NextResponse } from "next/server";
import {
  classifyIntent,
  extractPickLimit,
  extractRequestedMatch,
} from "@/lib/ai/intent";
import { analyseFixtures } from "@/lib/model/analyseFixtures";
import { findOddsFixture, getUpcomingOddsFixtures } from "@/lib/stats/oddsApi";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { message?: unknown };
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return NextResponse.json({ error: "Enter a football question." }, { status: 400 });
    }

    const message = body.message.trim();
    const intent = await classifyIntent(message);
    if (intent === "best_plays") {
      const fixtures = (await getUpcomingOddsFixtures()).slice(0, 6);
      const picks = await analyseFixtures(fixtures, { limit: extractPickLimit(message) });
      return NextResponse.json({
        intent,
        reply: picks.length > 0
          ? `Analysed ${fixtures.length} upcoming fixtures and ranked ${picks.length} picks by expected value.`
          : "No upcoming fixtures with odds are available to analyse. Check ODDS_API_KEY and try again.",
        picks,
      });
    }

    if (intent === "analyse_match") {
      const requestedMatch = extractRequestedMatch(message);
      if (!requestedMatch) {
        return NextResponse.json({
          intent,
          reply: "Name the match in the format Team A vs Team B.",
          picks: [],
        });
      }

      const fixtures = await getUpcomingOddsFixtures();
      const fixture = findOddsFixture(fixtures, requestedMatch.home, requestedMatch.away);
      if (!fixture) {
        return NextResponse.json({
          intent,
          reply: `I couldn't match ${requestedMatch.home} vs ${requestedMatch.away} to an upcoming fixture with live odds.`,
          picks: [],
        });
      }

      const picks = await analyseFixtures([fixture], { limit: extractPickLimit(message) });
      return NextResponse.json({
        intent,
        reply: `Analysed ${fixture.home_team} vs ${fixture.away_team} and ranked ${picks.length} picks by expected value.`,
        picks,
        fixture,
      });
    }

    const reply = intent === "explain_pick"
      ? "Select a pick card to see the computed data behind it."
      : "Ask for the best plays, high-probability picks, or analyse a specific match.";
    return NextResponse.json({ intent, reply, picks: [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not process the chat question.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
