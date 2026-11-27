import { NextRequest, NextResponse } from "next/server";
import {
  classifyIntent,
  extractPickLimit,
  extractRequestedMatch,
  extractTargetMarket,
  normalizeFootballQuestion,
  type RequestedMatch,
} from "@/lib/ai/intent";
import { answerPunterQuestion, formatPunterPicks } from "@/lib/ai/punterChat";
import { analyseFixtures } from "@/lib/model/analyseFixtures";
import { findOddsFixture, getUpcomingOddsFixtures, type OddsFixture } from "@/lib/stats/oddsApi";
import type { Pick } from "@/lib/stats/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function isRequestedMatch(value: unknown): value is RequestedMatch {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.home === "string" && typeof record.away === "string";
}

function findMentionedFixtures(fixtures: OddsFixture[], message: string): OddsFixture[] {
  const text = normalizeFootballQuestion(message).toLowerCase();
  const mentions = (name: string) => {
    const tokens = normalizeFootballQuestion(name).toLowerCase().split(/[^a-z0-9]+/).filter((token) =>
      token.length > 2 && !["the", "fc", "cf", "afc", "sc"].includes(token),
    );
    const firstTeamToken = tokens[0];
    return tokens.length > 0 && (
      tokens.every((token) => text.includes(token)) ||
      (firstTeamToken.length >= 5 && text.split(/[^a-z0-9]+/).includes(firstTeamToken))
    );
  };
  const mentioned = fixtures.flatMap((fixture) => {
    const home = mentions(fixture.home_team);
    const away = mentions(fixture.away_team);
    return home || away ? [{ fixture, both: home && away }] : [];
  });
  return mentioned
    .sort((a, b) => Number(b.both) - Number(a.both) ||
      Date.parse(a.fixture.commence_time) - Date.parse(b.fixture.commence_time))
    .slice(0, 3)
    .map(({ fixture }) => fixture);
}

function describePicks(picks: Pick[], fixtureCount: number): string {
  if (picks.length === 0) {
    return fixtureCount === 0
      ? "No upcoming fixtures with usable live odds are available in the next 36 hours."
      : "I couldn't produce a valid pick from the available fixture data.";
  }
  return formatPunterPicks(picks);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      message?: unknown;
      lastMatchedFixture?: unknown;
    };
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return NextResponse.json({ error: "Enter a football question." }, { status: 400 });
    }

    const message = body.message.trim();
    const intent = await classifyIntent(message);
    if (intent === "open_board") {
      return NextResponse.json({
        intent,
        openBoard: true,
        reply: "Opening the Analysis Board with the picks from this conversation.",
        picks: [],
      });
    }

    const lastMatchedFixture = isRequestedMatch(body.lastMatchedFixture)
      ? body.lastMatchedFixture
      : undefined;
    const requestedMatch = extractRequestedMatch(message) ?? lastMatchedFixture;
    const targetMarket = extractTargetMarket(message);
    const limit = extractPickLimit(message) ?? 5;

    if (intent === "best_plays") {
      const fixtures = await getUpcomingOddsFixtures();
      const picks = await analyseFixtures(fixtures, {
        limit,
        singleBestPerMatch: true,
        targetMarket,
      });
      return NextResponse.json({
        intent,
        openBoard: false,
        reply: describePicks(picks, fixtures.length),
        picks,
      });
    }

    if (intent === "analyse_match" && !requestedMatch) {
      return NextResponse.json({
        intent,
        openBoard: false,
        reply: "Name the match in the format Team A vs Team B, or continue with a match from earlier in this chat.",
        picks: [],
      });
    }

    const fixtures = await getUpcomingOddsFixtures();
    if (intent === "analyse_match" && requestedMatch) {
      const fixture = findOddsFixture(fixtures, requestedMatch.home, requestedMatch.away);
      if (!fixture) {
        return NextResponse.json({
          intent,
          openBoard: false,
          reply: `I couldn't match ${requestedMatch.home} vs ${requestedMatch.away} to an upcoming fixture in the 36-hour live window.`,
          picks: [],
        });
      }

      const picks = await analyseFixtures([fixture], {
        limit: 1,
        singleBestPerMatch: true,
        targetMarket,
      });
      return NextResponse.json({
        intent,
        openBoard: false,
        reply: describePicks(picks, 1),
        picks,
        fixture: { home: fixture.home_team, away: fixture.away_team },
      });
    }

    const mentionedFixtures = findMentionedFixtures(fixtures, message);
    const analyzed = mentionedFixtures.length > 0
      ? await analyseFixtures(mentionedFixtures, {
          limit: 3,
          singleBestPerMatch: true,
          targetMarket,
        })
      : [];
    const reply = intent === "explain_pick"
      ? analyzed.length > 0
        ? await answerPunterQuestion(message, analyzed)
        : "There isn't a pick with fetched match data in this conversation to explain."
      : await answerPunterQuestion(message, analyzed);

    const matched = mentionedFixtures[0];
    return NextResponse.json({
      intent,
      openBoard: false,
      reply,
      picks: analyzed,
      ...(matched ? { fixture: { home: matched.home_team, away: matched.away_team } } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not process the chat question.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
