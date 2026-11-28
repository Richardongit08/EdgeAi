import { NextRequest, NextResponse } from "next/server";
import {
  extractPickLimit,
  extractRequestedMatch,
  extractTargetMarket,
  normalizeFootballQuestion,
  parseChatIntent,
  type RequestedMatch,
} from "@/lib/ai/intent";
import { answerPunterQuestion, formatPunterPicks } from "@/lib/ai/punterChat";
import { analyseAccumulator, analyseFixtures } from "@/lib/model/analyseFixtures";
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
      ? "No upcoming fixtures are scheduled in the next 36 hours."
      : "No grounded pick is available: the fetched team statistics are insufficient for the requested market.";
  }
  return formatPunterPicks(picks);
}

function formatRiskProfile(riskProfile: string): string {
  return riskProfile.replace("_", "-");
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
    const parsedIntent = await parseChatIntent(message);
    const intent = parsedIntent.intent;
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
    const limit = parsedIntent.gameCount ?? extractPickLimit(message) ?? 5;

    if (intent === "best_plays") {
      const fixtures = await getUpcomingOddsFixtures();
      const accumulatorRequested = targetMarket === "all" && (
        parsedIntent.gameCount !== undefined ||
        parsedIntent.targetTotalOdds !== undefined ||
        parsedIntent.riskProfile !== "balanced"
      );
      if (accumulatorRequested) {
        const accumulator = await analyseAccumulator(fixtures, {
          ...(parsedIntent.gameCount !== undefined
            ? { gameCount: parsedIntent.gameCount }
            : parsedIntent.targetTotalOdds === undefined
              ? { gameCount: limit }
              : {}),
          ...(parsedIntent.targetTotalOdds !== undefined
            ? { targetTotalOdds: parsedIntent.targetTotalOdds }
            : {}),
          riskProfile: parsedIntent.riskProfile,
        });
        const picks = accumulator.reachedTarget ? accumulator.legs : [];
        const reply = picks.length > 0
          ? [
              formatPunterPicks(picks),
              `Legs: ${picks.length} | Target Odds: ${accumulator.targetTotalOdds?.toString() ?? "not set"} | Combined Accumulator Odds: ${accumulator.combinedOdds.toFixed(2)} | Risk Profile: ${formatRiskProfile(accumulator.riskProfile)}`,
            ].join("\n\n")
          : fixtures.length === 0
            ? "No upcoming fixtures are scheduled in the next 36 hours."
            : "I couldn't build an accumulator meeting the requested game count and odds target from available picks.";
        return NextResponse.json({
          intent,
          openBoard: false,
          reply,
          picks,
          accumulator: {
            legs: picks.length,
            combinedOdds: accumulator.combinedOdds,
            targetTotalOdds: accumulator.targetTotalOdds,
            riskProfile: accumulator.riskProfile,
            reachedTarget: accumulator.reachedTarget,
          },
        });
      }

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
