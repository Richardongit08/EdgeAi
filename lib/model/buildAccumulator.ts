import type { RiskProfile } from "@/lib/ai/intent";
import type { Pick } from "@/lib/stats/types";

export interface AccumulatorOptions {
  gameCount?: number;
  targetTotalOdds?: number;
  riskProfile?: RiskProfile;
}

export interface AccumulatorResult {
  legs: Pick[];
  combinedOdds: number;
  gameCount?: number;
  targetTotalOdds?: number;
  riskProfile: RiskProfile;
  reachedTarget: boolean;
}

interface LegState {
  legs: Pick[];
  odds: number;
}

const PROFILE_BANDS: Record<Exclude<RiskProfile, "multi_combo">, [number, number]> = {
  safe: [1.2, 1.55],
  balanced: [1.45, 1.95],
  risky: [2, 3.5],
};
const MULTI_COMBO_SAFE_BAND: [number, number] = [1.2, 1.55];
const MULTI_COMBO_VALUE_BAND: [number, number] = [1.65, 3.5];
const TARGET_TOLERANCE = [0.85, 1.2] as const;
const BEAM_WIDTH_PER_LEG_COUNT = 40;
const CANDIDATES_PER_MATCH = 6;

function oddsOf(pick: Pick): number | undefined {
  return pick.bookOdds !== null && Number.isFinite(pick.bookOdds) && pick.bookOdds > 1
    ? pick.bookOdds
    : undefined;
}

function compareQuality(a: Pick, b: Pick): number {
  return b.modelProb - a.modelProb ||
    (b.ev ?? -Infinity) - (a.ev ?? -Infinity) ||
    (oddsOf(a) ?? Infinity) - (oddsOf(b) ?? Infinity);
}

function inBand(pick: Pick, band: [number, number]): boolean {
  const odds = oddsOf(pick);
  return odds !== undefined && odds >= band[0] && odds <= band[1];
}

function marketCategory(pick: Pick): string {
  const market = pick.market.toLowerCase();
  if (market.includes("goal") || market.includes("total")) return "totals";
  if (market.includes("double chance")) return "double-chance";
  if (market.includes("btts") || market.includes("both teams")) return "btts";
  if (market.includes("handicap") || market.includes("spread")) return "handicap";
  if (market.includes("correct score")) return "correct-score";
  return "result";
}

function groupByMatch(picks: Pick[]): Pick[][] {
  const groups = new Map<string, Pick[]>();
  for (const pick of picks) {
    const key = pick.match.trim().toLowerCase();
    const current = groups.get(key) ?? [];
    current.push(pick);
    groups.set(key, current);
  }
  return [...groups.values()];
}

function chooseByQualityAndDiversity(candidates: Pick[], count: number): Pick[] {
  const selected: Pick[] = [];
  const usedMatches = new Set<string>();
  const marketCounts = new Map<string, number>();

  while (selected.length < count) {
    const available = candidates.filter((pick) =>
      !usedMatches.has(pick.match.trim().toLowerCase()),
    );
    if (available.length === 0) break;
    available.sort((a, b) => {
      const categoryDifference =
        (marketCounts.get(marketCategory(a)) ?? 0) -
        (marketCounts.get(marketCategory(b)) ?? 0);
      return categoryDifference || compareQuality(a, b);
    });
    const next = available[0];
    selected.push(next);
    usedMatches.add(next.match.trim().toLowerCase());
    const category = marketCategory(next);
    marketCounts.set(category, (marketCounts.get(category) ?? 0) + 1);
  }
  return selected;
}

function buildExactCount(
  candidates: Pick[],
  gameCount: number,
  riskProfile: RiskProfile,
): Pick[] {
  if (riskProfile !== "multi_combo") {
    const band = PROFILE_BANDS[riskProfile];
    const legs = chooseByQualityAndDiversity(
      candidates.filter((pick) => inBand(pick, band)).sort(compareQuality),
      gameCount,
    );
    return legs.length === gameCount ? legs : [];
  }

  if (gameCount === 1) {
    return chooseByQualityAndDiversity(
      candidates.filter((pick) =>
        inBand(pick, MULTI_COMBO_SAFE_BAND) || inBand(pick, MULTI_COMBO_VALUE_BAND),
      ).sort(compareQuality),
      1,
    );
  }

  const safeCount = Math.ceil(gameCount / 2);
  const safeLegs = chooseByQualityAndDiversity(
    candidates.filter((pick) => inBand(pick, MULTI_COMBO_SAFE_BAND)).sort(compareQuality),
    safeCount,
  );
  const selectedMatches = new Set(safeLegs.map((pick) => pick.match.trim().toLowerCase()));
  const valueLegs = chooseByQualityAndDiversity(
    candidates.filter((pick) =>
      inBand(pick, MULTI_COMBO_VALUE_BAND) &&
      !selectedMatches.has(pick.match.trim().toLowerCase()),
    ).sort(compareQuality),
    gameCount - safeLegs.length,
  );
  const selected = [...safeLegs, ...valueLegs];
  if (selected.length !== gameCount || safeLegs.length === 0 || valueLegs.length === 0) return [];
  return selected;
}

function stateScore(state: LegState, targetPerLeg: number, riskProfile: RiskProfile): number {
  const targetProduct = targetPerLeg ** state.legs.length;
  const productDistance = Math.abs(Math.log(state.odds / targetProduct));
  const averageProbability = state.legs.reduce((sum, pick) => sum + pick.modelProb, 0) /
    Math.max(state.legs.length, 1);
  const categoryCounts = new Map<string, number>();
  for (const pick of state.legs) {
    const category = marketCategory(pick);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const duplicateMarkets = [...categoryCounts.values()].reduce((sum, count) =>
    sum + Math.max(0, count - 1), 0,
  );
  const safeLegs = state.legs.filter((pick) => inBand(pick, MULTI_COMBO_SAFE_BAND)).length;
  const valueLegs = state.legs.filter((pick) => inBand(pick, MULTI_COMBO_VALUE_BAND)).length;
  const mixPenalty = riskProfile === "multi_combo" && state.legs.length > 1
    ? Math.abs(safeLegs - state.legs.length / 2) * 0.04
    : 0;
  return productDistance + duplicateMarkets * 0.025 + mixPenalty - averageProbability * 0.01;
}

function pruneBeam(states: LegState[], targetPerLeg: number, riskProfile: RiskProfile): LegState[] {
  const byLegCount = new Map<number, LegState[]>();
  for (const state of states) {
    const group = byLegCount.get(state.legs.length) ?? [];
    group.push(state);
    byLegCount.set(state.legs.length, group);
  }
  return [...byLegCount.values()].flatMap((group) =>
    group.sort((a, b) =>
      stateScore(a, targetPerLeg, riskProfile) - stateScore(b, targetPerLeg, riskProfile),
    ).slice(0, BEAM_WIDTH_PER_LEG_COUNT),
  );
}

function buildExactTarget(
  candidates: Pick[],
  gameCount: number,
  targetTotalOdds: number,
  riskProfile: RiskProfile,
): Pick[] {
  const targetPerLeg = targetTotalOdds ** (1 / gameCount);
  const bandCandidates = candidates.filter((pick) => {
    if (riskProfile === "multi_combo") {
      return inBand(pick, MULTI_COMBO_SAFE_BAND) || inBand(pick, MULTI_COMBO_VALUE_BAND);
    }
    return inBand(pick, PROFILE_BANDS[riskProfile]);
  });
  const groups = groupByMatch(bandCandidates)
    .map((group) => group.sort((a, b) =>
      Math.abs(Math.log((oddsOf(a) ?? 1) / targetPerLeg)) -
        Math.abs(Math.log((oddsOf(b) ?? 1) / targetPerLeg)) ||
      compareQuality(a, b),
    ).slice(0, CANDIDATES_PER_MATCH))
    .sort((a, b) => {
      const aDistance = Math.abs(Math.log((oddsOf(a[0]) ?? 1) / targetPerLeg));
      const bDistance = Math.abs(Math.log((oddsOf(b[0]) ?? 1) / targetPerLeg));
      return aDistance - bDistance;
    });

  let beam: LegState[] = [{ legs: [], odds: 1 }];
  for (const group of groups) {
    const nextStates = [...beam];
    for (const state of beam) {
      if (state.legs.length >= gameCount) continue;
      for (const pick of group) {
        const odds = oddsOf(pick);
        if (odds !== undefined) nextStates.push({ legs: [...state.legs, pick], odds: state.odds * odds });
      }
    }
    beam = pruneBeam(nextStates, targetPerLeg, riskProfile);
  }

  const minimumOdds = targetTotalOdds * TARGET_TOLERANCE[0];
  const maximumOdds = targetTotalOdds * TARGET_TOLERANCE[1];
  return beam
    .filter((state) => {
      if (state.legs.length !== gameCount || state.odds < minimumOdds || state.odds > maximumOdds) {
        return false;
      }
      if (riskProfile !== "multi_combo" || gameCount === 1) return true;
      return state.legs.some((pick) => inBand(pick, MULTI_COMBO_SAFE_BAND)) &&
        state.legs.some((pick) => inBand(pick, MULTI_COMBO_VALUE_BAND));
    })
    .sort((a, b) => {
      const totalDistance = Math.abs(Math.log(a.odds / targetTotalOdds)) -
        Math.abs(Math.log(b.odds / targetTotalOdds));
      return totalDistance ||
        stateScore(a, targetPerLeg, riskProfile) - stateScore(b, targetPerLeg, riskProfile);
    })[0]?.legs ?? [];
}

function buildTargetOnly(
  candidates: Pick[],
  targetTotalOdds: number,
  riskProfile: RiskProfile,
): Pick[] {
  const eligible = candidates.filter((pick) => {
    if (riskProfile === "multi_combo") {
      return inBand(pick, MULTI_COMBO_SAFE_BAND) || inBand(pick, MULTI_COMBO_VALUE_BAND);
    }
    return inBand(pick, PROFILE_BANDS[riskProfile]);
  });
  const selected: Pick[] = [];
  const usedMatches = new Set<string>();
  const targetFloor = targetTotalOdds * 0.9;
  let combinedOdds = 1;
  let safeLegCount = 0;
  let valueLegCount = 0;
  const marketCounts = new Map<string, number>();

  while (combinedOdds < targetFloor) {
    const preferredBand = riskProfile === "multi_combo"
      ? safeLegCount <= valueLegCount ? MULTI_COMBO_SAFE_BAND : MULTI_COMBO_VALUE_BAND
      : undefined;
    let available = eligible.filter((pick) =>
      !usedMatches.has(pick.match.trim().toLowerCase()) &&
      (!preferredBand || inBand(pick, preferredBand)),
    );
    if (available.length === 0 && riskProfile === "multi_combo") {
      available = eligible.filter((pick) =>
        !usedMatches.has(pick.match.trim().toLowerCase()),
      );
    }
    if (available.length === 0) break;

    const closingCandidates = available.filter((pick) => {
      const total = combinedOdds * (oddsOf(pick) ?? 1);
      return total >= targetFloor && total <= targetTotalOdds * 1.2;
    });
    closingCandidates.sort((a, b) =>
      Math.abs(combinedOdds * (oddsOf(a) ?? 1) - targetTotalOdds) -
        Math.abs(combinedOdds * (oddsOf(b) ?? 1) - targetTotalOdds) ||
      (marketCounts.get(marketCategory(a)) ?? 0) -
        (marketCounts.get(marketCategory(b)) ?? 0) ||
      compareQuality(a, b),
    );
    if (closingCandidates.length > 0) {
      available = closingCandidates;
    } else {
      available.sort((a, b) =>
        (marketCounts.get(marketCategory(a)) ?? 0) -
          (marketCounts.get(marketCategory(b)) ?? 0) ||
        compareQuality(a, b),
      );
    }

    const next = available[0];
    const nextOdds = oddsOf(next);
    if (nextOdds === undefined) break;
    selected.push(next);
    usedMatches.add(next.match.trim().toLowerCase());
    combinedOdds *= nextOdds;
    const category = marketCategory(next);
    marketCounts.set(category, (marketCounts.get(category) ?? 0) + 1);
    if (inBand(next, MULTI_COMBO_SAFE_BAND)) safeLegCount += 1;
    if (inBand(next, MULTI_COMBO_VALUE_BAND)) valueLegCount += 1;
  }
  if (
    riskProfile === "multi_combo" &&
    selected.length > 1 &&
    (safeLegCount === 0 || valueLegCount === 0)
  ) return [];
  return selected;
}

export function buildAccumulator(
  candidates: Pick[],
  options: AccumulatorOptions,
): AccumulatorResult {
  const riskProfile = options.riskProfile ?? "balanced";
  const gameCount = options.gameCount === undefined
    ? undefined
    : Math.max(1, Math.min(50, Math.floor(options.gameCount)));
  const targetTotalOdds = options.targetTotalOdds !== undefined &&
      Number.isFinite(options.targetTotalOdds) && options.targetTotalOdds > 1
    ? options.targetTotalOdds
    : undefined;

  let legs: Pick[] = [];
  if (gameCount !== undefined && targetTotalOdds !== undefined) {
    legs = buildExactTarget(candidates, gameCount, targetTotalOdds, riskProfile);
  } else if (gameCount !== undefined) {
    legs = buildExactCount(candidates, gameCount, riskProfile);
  } else if (targetTotalOdds !== undefined) {
    legs = buildTargetOnly(candidates, targetTotalOdds, riskProfile);
  }

  const combinedOdds = legs.reduce((total, pick) => total * (oddsOf(pick) ?? 1), 1);
  const reachedTarget = gameCount !== undefined
    ? legs.length === gameCount &&
      (targetTotalOdds === undefined ||
        (combinedOdds >= targetTotalOdds * TARGET_TOLERANCE[0] &&
          combinedOdds <= targetTotalOdds * TARGET_TOLERANCE[1]))
    : targetTotalOdds === undefined || combinedOdds >= targetTotalOdds * 0.9;
  return {
    legs,
    combinedOdds,
    ...(gameCount !== undefined ? { gameCount } : {}),
    ...(targetTotalOdds !== undefined ? { targetTotalOdds } : {}),
    riskProfile,
    reachedTarget,
  };
}
