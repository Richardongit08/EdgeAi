import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/chat/route";
import { analyseAccumulator } from "../lib/model/analyseFixtures";
import { getUpcomingOddsFixtures } from "../lib/stats/oddsApi";
import type { Pick } from "../lib/stats/types";

vi.mock("../lib/model/analyseFixtures", async () => {
  const actual = await vi.importActual<typeof import("../lib/model/analyseFixtures")>(
    "../lib/model/analyseFixtures",
  );
  return {
    ...actual,
    analyseAccumulator: vi.fn(),
    analyseFixtures: vi.fn(),
  };
});

vi.mock("../lib/stats/oddsApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/stats/oddsApi")>(
    "../lib/stats/oddsApi",
  );
  return { ...actual, getUpcomingOddsFixtures: vi.fn() };
});

const legs: Pick[] = Array.from({ length: 3 }, (_, index) => ({
  match: `Home ${index} vs Away ${index}`,
  market: "Double Chance",
  selection: "1X",
  modelProb: 0.72,
  bookOdds: 1.5,
  fairProb: 1 / 1.5,
  edge: 0.72 - 1 / 1.5,
  ev: 0.08,
  confidence: "medium",
  justification: "Modelled test pick.",
  dataQuality: "partial",
}));

describe("chat route accumulators", () => {
  it("returns selected legs with target odds and the risk profile", async () => {
    const fixtures = [{
      id: "route-accumulator",
      sport_key: "soccer_epl",
      commence_time: "2026-12-01T19:00:00Z",
      home_team: "Arsenal",
      away_team: "Chelsea",
      bookmakers: [],
    }];
    vi.mocked(getUpcomingOddsFixtures).mockResolvedValue(fixtures);
    vi.mocked(analyseAccumulator).mockResolvedValue({
      legs,
      combinedOdds: 9,
      targetTotalOdds: 10,
      riskProfile: "safe",
      reachedTarget: true,
    });

    const response = await POST(new NextRequest("https://edgeai.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "safest plays today that would sum up to 10 odds",
      }),
    }));
    const body = await response.json();

    expect(analyseAccumulator).toHaveBeenCalledWith(fixtures, {
      targetTotalOdds: 10,
      riskProfile: "safe",
    });
    expect(body.picks).toHaveLength(3);
    expect(body.reply).toContain("Legs: 3 | Target Odds: 10 | Combined Accumulator Odds: 9.00 | Risk Profile: safe");
    expect(body.accumulator).toMatchObject({
      legs: 3,
      targetTotalOdds: 10,
      combinedOdds: 9,
      riskProfile: "safe",
      reachedTarget: true,
    });
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
