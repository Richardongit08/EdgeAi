import { NextRequest, NextResponse } from "next/server";
import { classifyIntent } from "@/lib/ai/intent";
import { getFixtures } from "@/lib/stats/apiFootball";

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
    let bestPlaysNote = "";
    if (intent === "best_plays") {
      const today = new Date().toISOString().slice(0, 10);
      const inSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const fixturesResult = await Promise.allSettled([
        getFixtures({ date: today, from: today, to: inSevenDays }),
      ]);
      const first = fixturesResult[0];
      if (first.status === "fulfilled") {
        bestPlaysNote = ` Scan is limited to the top 6 upcoming fixtures. ${first.value.response.length} fixtures available.`;
      }
    }
    const responses: Record<typeof intent, string> = {
      best_plays: `I can rank value plays only after live team statistics and the available bookmaker prices are loaded.${bestPlaysNote}`,
      analyse_match: "Send a match in the format Team vs Team, or upload a screenshot containing the odds.",
      explain_pick: "Select a pick card to see the computed data behind it.",
      general: "Ask for the best plays today, analyse a specific match, or upload a fixtures and odds screenshot.",
    };
    return NextResponse.json({ intent, message: responses[intent] });
  } catch {
    return NextResponse.json({ error: "Could not process the chat question." }, { status: 400 });
  }
}
