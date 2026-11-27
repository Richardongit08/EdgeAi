import type { Pick } from "@/lib/stats/types";
import type { TargetMarket } from "@/lib/ai/intent";

function isMarket(pick: Pick, targetMarket: TargetMarket): boolean {
  const market = pick.market.toLowerCase();
  const selection = pick.selection.toLowerCase();
  switch (targetMarket) {
    case "all":
      return true;
    case "goals":
      return /goal|total/.test(market) && !/shot/.test(market);
    case "correct_score":
      return market.includes("correct score");
    case "total_shots":
      return market.includes("total shots");
    case "btts":
      return market.includes("btts") || market.includes("both teams");
    case "1x2":
      return /1x2|match result|match winner/.test(market);
    case "double_chance":
      return market.includes("double chance");
    case "draw_no_bet":
      return market.includes("draw no bet");
    case "asian_handicap":
      return market.includes("handicap") || market.includes("spread");
    default:
      return selection.length > 0;
  }
}

export function selectSingleBestPick(
  picks: Pick[],
  options: { targetMarket?: TargetMarket; limit?: number } = {},
): Pick[] {
  const targetMarket = options.targetMarket ?? "all";
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 5)));
  const bestByMatch = new Map<string, Pick>();

  for (const pick of picks) {
    if (!Number.isFinite(pick.modelProb) || pick.modelProb < 0 || pick.modelProb > 1 || !isMarket(pick, targetMarket)) continue;
    const key = pick.match.trim().toLocaleLowerCase();
    const existing = bestByMatch.get(key);
    if (
      !existing ||
      pick.modelProb > existing.modelProb ||
      (pick.modelProb === existing.modelProb && (pick.ev ?? -Infinity) > (existing.ev ?? -Infinity))
    ) {
      bestByMatch.set(key, pick);
    }
  }

  return [...bestByMatch.values()]
    .sort((a, b) => b.modelProb - a.modelProb || (b.ev ?? -Infinity) - (a.ev ?? -Infinity))
    .slice(0, limit);
}
