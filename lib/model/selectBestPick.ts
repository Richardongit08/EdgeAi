import type { Pick, TargetMarket } from "@/lib/stats/types";

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

export function selectSingleBestPick(
  candidates: Pick[],
  options?: { targetMarket?: TargetMarket; limit?: number },
): Pick[] {
  const targetMarket = options?.targetMarket;
  const filtered = targetMarket !== undefined && targetMarket !== "all"
    ? candidates.filter((pick) => pick.market.toLowerCase() === targetMarket.toLowerCase())
    : candidates;
  const bestByMatch = new Map<string, Pick>();

  for (const candidate of filtered) {
    const key = candidate.match.trim().toLowerCase();
    const current = bestByMatch.get(key);
    if (!current || compareProbability(candidate, current) < 0) {
      bestByMatch.set(key, candidate);
    }
  }

  const ranked = [...bestByMatch.values()].sort(compareProbability);
  if (options?.limit === undefined) return ranked;
  return ranked.slice(0, Math.max(0, Math.floor(options.limit)));
}
