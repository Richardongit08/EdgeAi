import { generateWithFallback } from "@/lib/ai/generate";
import type { Pick } from "@/lib/stats/types";

export function formatPunterPicks(picks: Pick[]): string {
  return picks.map((pick) => {
    const chance = `${(pick.modelProb * 100).toFixed(1)}%`;
    const odds = pick.bookOdds === null ? "@ Model Fair" : `@ ${pick.bookOdds.toFixed(2)}`;
    const note = pick.bookOdds !== null && pick.ev !== null && pick.ev > 0
      ? `At the listed price, the model's estimated expected return is ${(pick.ev * 100).toFixed(1)}%.`
      : pick.bookOdds === null
        ? "No live bookmaker price was available, so this is a probability view rather than a verified value edge."
        : "The model probability is based on the available scoring data; the listed price does not show positive modelled value.";
    return `- **${pick.match}** — **${pick.selection}** (${chance}) · Odds \`${odds}\`. ${note}`;
  }).join("\n");
}

export async function answerPunterQuestion(question: string, evidence: Pick[]): Promise<string> {
  if (evidence.length === 0) {
    return "I don't have a matching upcoming fixture or fetched team statistics for that question, so I can't give a data-backed verdict. Ask about a listed fixture or try again when live stats are available.";
  }

  try {
    return await generateWithFallback(
      `You are a cautious professional football punter co-pilot. Answer in concise prose. Use only the fetched computed evidence below: do not use prior knowledge, invent form, injuries, odds, or statistics, and do not call any bet safe or guaranteed. If the evidence does not contain a requested stat, clearly say it is unavailable. Distinguish model probability from bookmaker value.\n\nQuestion: ${question}\nFetched computed evidence: ${JSON.stringify(evidence)}`,
      { temperature: 0.2 },
    );
  } catch {
    return evidence.map((pick) => `${pick.match}: ${pick.justification}`).join("\n");
  }
}
