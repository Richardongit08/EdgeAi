import type { Pick } from "@/lib/stats/types";

const HIGH_PROBABILITY_THRESHOLD = 0.5;

function compareProbability(a: Pick, b: Pick): number {
  return b.modelProb - a.modelProb || (b.ev ?? -Infinity) - (a.ev ?? -Infinity);
}

export function selectBestPick(picks: Pick[], targetMarket = "all"): Pick | undefined {
  if (targetMarket === "all") {
    const pricedHighProbabilityPicks = picks.filter((pick) =>
      pick.modelProb >= HIGH_PROBABILITY_THRESHOLD &&
      pick.bookOdds !== null &&
      Number.isFinite(pick.bookOdds) &&
      pick.bookOdds > 1,
    );
    if (pricedHighProbabilityPicks.length > 0) {
      return [...pricedHighProbabilityPicks].sort(compareProbability)[0];
    }
  }

  return [...picks].sort(compareProbability)[0];
}
