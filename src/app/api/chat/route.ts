import { NextRequest, NextResponse } from "next/server";
import { classifyIntent } from "@/lib/ai/intent";
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
    const fixtures = intent === "best_plays" || intent === "analyse_match"
      ? await getUpcomingOddsFixtures()
      : [];
    const upcoming = fixtures.slice(0, 6);
    const fixtureLines = (items: typeof upcoming) => items.map((fixture) =>
      `${fixture.home_team} vs ${fixture.away_team} (${new Date(fixture.commence_time).toLocaleString()})`,
    );
    const pair = message
      .replace(/^(please\s+)?(analyse|analyze)(\s+the)?(\s+match)?\s+/i, "")
      .match(/^(.+?)\s+(?:vs|versus|v)\s+(.+?)(?:\s+(?:tonight|today|tomorrow|this\s+week|on\s+.+))?$/i);
    const specificFixture = pair
      ? findOddsFixture(fixtures, pair[1].trim(), pair[2].trim())
      : undefined;
    const responses: Record<typeof intent, string> = {
      best_plays: upcoming.length > 0
        ? `Upcoming fixtures with live odds (showing the first ${upcoming.length}):\n${fixtureLines(upcoming).join("\n")}`
        : "No upcoming fixtures with live odds are currently available. Check ODDS_API_KEY and try again.",
      analyse_match: specificFixture
        ? `Found the requested fixture from live odds: ${specificFixture.home_team} vs ${specificFixture.away_team} at ${new Date(specificFixture.commence_time).toLocaleString()}.`
        : pair
          ? `The requested fixture was not found in the upcoming live-odds list.${upcoming.length ? ` Upcoming fixtures:\n${fixtureLines(upcoming).join("\n")}` : ""}`
          : `Name a fixture in the format Team vs Team.${upcoming.length ? ` Upcoming fixtures:\n${fixtureLines(upcoming).join("\n")}` : ""}`,
      explain_pick: "Select a pick card to see the computed data behind it.",
      general: "Ask for the best plays today, analyse a specific match, or upload a fixtures and odds screenshot.",
    };
    return NextResponse.json({
      intent,
      message: responses[intent],
      fixtures: intent === "analyse_match"
        ? specificFixture ? [specificFixture] : upcoming
        : intent === "best_plays" ? upcoming : [],
      fixture: specificFixture ?? null,
    });
  } catch {
    return NextResponse.json({ error: "Could not process the chat question." }, { status: 400 });
  }
}
