import { NextRequest, NextResponse } from "next/server";
import {
  classifyMessage,
  parseChatContext,
  type FixtureReference,
} from "@/lib/ai/intent";
import { analyseFixtures, rankPicks } from "@/lib/model/analyseFixtures";
import { teamNameSimilarity } from "@/lib/stats/fuzzy";
import {
  findOddsFixture,
  getUpcomingOddsFixtures,
  type OddsFixture,
} from "@/lib/stats/oddsApi";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function toFixtureReference(fixture: OddsFixture): FixtureReference {
  return {
    id: fixture.id,
    sport_key: fixture.sport_key,
    commence_time: fixture.commence_time,
    home_team: fixture.home_team,
    away_team: fixture.away_team,
  };
}

function fixtureFromReference(
  fixtures: OddsFixture[],
  reference: FixtureReference,
): OddsFixture | undefined {
  return fixtures.find((fixture) => fixture.id === reference.id) ??
    findOddsFixture(fixtures, reference.home_team, reference.away_team);
}

function selectContextFixtures(fixtures: OddsFixture[], references: FixtureReference[]): OddsFixture[] {
  const selected = references.flatMap((reference) => {
    const fixture = fixtureFromReference(fixtures, reference);
    return fixture ? [fixture] : [];
  });
  return [...new Map(selected.map((fixture) => [fixture.id, fixture])).values()];
}

function findTeamFixture(fixtures: OddsFixture[], team: string): OddsFixture | undefined {
  return fixtures
    .map((fixture) => ({
      fixture,
      similarity: Math.max(
        teamNameSimilarity(team, fixture.home_team),
        teamNameSimilarity(team, fixture.away_team),
      ),
    }))
    .filter((match) => match.similarity >= 0.72)
    .sort((a, b) => a.fixture.commence_time.localeCompare(b.fixture.commence_time) || b.similarity - a.similarity)[0]?.fixture;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { message?: unknown; context?: unknown };
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return NextResponse.json({ error: "Enter a football question." }, { status: 400 });
    }

    const message = body.message.trim();
    const context = parseChatContext(body.context);
    const classification = await classifyMessage(message, context);

    if (classification.openBoard) {
      const references = context.lastMatchedFixture
        ? [context.lastMatchedFixture]
        : context.lastFixtures ?? [];
      const fixtures = references.length > 0
        ? selectContextFixtures(await getUpcomingOddsFixtures(), references)
        : [];
      const boardPicks = fixtures.length > 0
        ? await analyseFixtures(fixtures, { limit: 300, sortBy: "probability", includeExplanation: false })
        : [];
      return NextResponse.json({
        intent: "show_board",
        reply: "Here’s the full statistical breakdown for the picks above.",
        picks: [],
        boardPicks,
        openBoard: true,
      });
    }

    if (classification.intent === "best_plays" || classification.intent === "analyse_match") {
      const availableFixtures = await getUpcomingOddsFixtures();
      let fixtures: OddsFixture[] = [];

      if (classification.intent === "analyse_match") {
        const reference = classification.useContext ? context.lastMatchedFixture : undefined;
        const fixture = reference
          ? fixtureFromReference(availableFixtures, reference)
          : classification.requestedMatch
            ? findOddsFixture(availableFixtures, classification.requestedMatch.home, classification.requestedMatch.away)
            : classification.requestedTeam
              ? findTeamFixture(availableFixtures, classification.requestedTeam)
              : undefined;
        if (!fixture) {
          const subject = classification.requestedMatch
            ? `${classification.requestedMatch.home} vs ${classification.requestedMatch.away}`
            : classification.requestedTeam ?? "that match";
          return NextResponse.json({
            intent: classification.intent,
            reply: `I couldn’t match ${subject} to an upcoming fixture with live odds.`,
            picks: [],
            fixtureRefs: [],
          });
        }
        fixtures = [fixture];
      } else if (classification.useContext && context.lastFixtures?.length) {
        fixtures = selectContextFixtures(availableFixtures, context.lastFixtures);
      } else {
        fixtures = availableFixtures.slice(0, 6);
      }

      if (fixtures.length === 0) {
        return NextResponse.json({
          intent: classification.intent,
          reply: classification.useContext
            ? "I couldn’t refresh the fixtures from our previous analysis."
            : "No upcoming fixtures with odds are available right now. Check ODDS_API_KEY and try again.",
          picks: [],
          fixtureRefs: [],
        });
      }

      const boardPicks = await analyseFixtures(fixtures, {
        limit: 300,
        sortBy: "probability",
        includeExplanation: false,
      });
      const picks = rankPicks(boardPicks, {
        limit: classification.allMarkets ? 50 : classification.limit,
        sortBy: classification.sortBy,
        distinctMatches: classification.distinctMatches,
        targetMarket: classification.targetMarket,
        selectionFilter: classification.selectionFilter,
      });
      const fixtureRefs = classification.distinctMatches && picks.length > 0
        ? fixtures.filter((fixture) => picks.some((pick) => pick.match === `${fixture.home_team} vs ${fixture.away_team}`))
        : fixtures;
      const reply = picks.length > 0
        ? `Here are ${picks.length} stats-led ${classification.targetMarket === "all" ? "picks" : classification.targetMarket.toLowerCase() + " picks"}, ranked by ${classification.sortBy === "probability" ? "estimated hit chance" : "expected value"}.`
        : classification.targetMarket === "Total Shots"
          ? "I don’t have recent ESPN shot-summary data for these fixtures, so I can’t estimate total shots yet."
          : "There are no modelled picks for that market in the selected fixtures.";

      return NextResponse.json({
        intent: classification.intent,
        reply,
        picks,
        boardPicks,
        fixture: fixtures.length === 1 ? toFixtureReference(fixtures[0]) : undefined,
        fixtureRefs: fixtureRefs.map(toFixtureReference),
        openBoard: false,
      });
    }

    const reply = classification.intent === "explain_pick"
      ? "Ask for the full breakdown to inspect the model probabilities, odds, edge, and data quality."
      : "Ask for high-probability games, a market such as goals or shots, or a specific team.";
    return NextResponse.json({ intent: classification.intent, reply, picks: [], openBoard: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not process the chat question.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
