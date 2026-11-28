import { describe, expect, it } from "vitest";
import { buildAccumulator } from "../lib/model/buildAccumulator";
import type { Pick } from "../lib/stats/types";

function pick(
  matchNumber: number,
  market: string,
  odds: number,
  modelProb = 0.7,
): Pick {
  return {
    match: `Home ${matchNumber} vs Away ${matchNumber}`,
    market,
    selection: "Pick",
    modelProb,
    bookOdds: odds,
    fairProb: 1 / odds,
    edge: modelProb - 1 / odds,
    ev: modelProb * odds - 1,
    confidence: "medium",
    justification: "Modelled test pick.",
    dataQuality: "partial",
  };
}

describe("accumulator builder", () => {
  it("builds the exact number of distinct risky legs close to a target total", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      pick(index, "1X2", 2, 0.5 + index / 100),
    );
    const accumulator = buildAccumulator(candidates, {
      gameCount: 4,
      targetTotalOdds: 15,
      riskProfile: "risky",
    });

    expect(accumulator.legs).toHaveLength(4);
    expect(new Set(accumulator.legs.map((leg) => leg.match)).size).toBe(4);
    expect(accumulator.combinedOdds).toBeGreaterThanOrEqual(15 * 0.85);
    expect(accumulator.combinedOdds).toBeLessThanOrEqual(15 * 1.2);
    expect(accumulator.reachedTarget).toBe(true);
  });

  it("accumulates safe legs until a target total is reached", () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      pick(index, "Double Chance", 1.5, 0.8 - index / 100),
    );
    const accumulator = buildAccumulator(candidates, {
      targetTotalOdds: 10,
      riskProfile: "safe",
    });

    expect(accumulator.legs.length).toBeGreaterThan(0);
    expect(accumulator.legs.every((leg) => leg.bookOdds! >= 1.2 && leg.bookOdds! <= 1.55)).toBe(true);
    expect(accumulator.combinedOdds).toBeGreaterThanOrEqual(9);
    expect(accumulator.reachedTarget).toBe(true);
  });

  it("does not return a partial set when the requested exact count is unavailable", () => {
    const accumulator = buildAccumulator([
      pick(0, "Double Chance", 1.4),
      pick(1, "Double Chance", 1.45),
    ], {
      gameCount: 3,
      riskProfile: "safe",
    });

    expect(accumulator.legs).toEqual([]);
    expect(accumulator.reachedTarget).toBe(false);
  });

  it("mixes safe anchors and value legs across different markets for multi-combo requests", () => {
    const candidates = Array.from({ length: 6 }, (_, index) => [
      pick(index, index % 2 ? "BTTS" : "Double Chance", 1.4, 0.8 - index / 100),
      pick(index, index % 2 ? "1X2" : "Goals Over/Under 2.5", 2, 0.5 + index / 100),
    ]).flat();
    const accumulator = buildAccumulator(candidates, {
      gameCount: 6,
      riskProfile: "multi_combo",
    });
    const odds = accumulator.legs.map((leg) => leg.bookOdds!);

    expect(accumulator.legs).toHaveLength(6);
    expect(new Set(accumulator.legs.map((leg) => leg.match)).size).toBe(6);
    expect(odds.some((value) => value <= 1.55)).toBe(true);
    expect(odds.some((value) => value >= 1.65)).toBe(true);
    expect(new Set(accumulator.legs.map((leg) => leg.market)).size).toBeGreaterThan(1);
    expect(accumulator.reachedTarget).toBe(true);
  });
});
