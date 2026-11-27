import { describe, expect, it } from "vitest";
import {
  classifyIntent,
  extractRequestedMatch,
  extractTargetMarket,
  shouldOpenAnalysisBoard,
} from "../lib/ai/intent";
import { selectSingleBestPick } from "../lib/model/selectBestPick";
import type { Pick } from "../lib/stats/types";

const picks: Pick[] = [
  {
    match: "Arsenal vs Chelsea",
    market: "Goals Over/Under 1.5",
    selection: "Over 1.5",
    modelProb: 0.81,
    bookOdds: 1.4,
    fairProb: 0.7,
    edge: 0.11,
    ev: 0.134,
    confidence: "high",
    justification: "Computed from the model.",
    dataQuality: "complete",
  },
  {
    match: "Arsenal vs Chelsea",
    market: "Goals Over/Under 2.5",
    selection: "Over 2.5",
    modelProb: 0.62,
    bookOdds: 1.9,
    fairProb: 0.5,
    edge: 0.12,
    ev: 0.178,
    confidence: "medium",
    justification: "Computed from the model.",
    dataQuality: "complete",
  },
  {
    match: "Arsenal vs Chelsea",
    market: "Correct Score",
    selection: "1-1",
    modelProb: 0.11,
    bookOdds: null,
    fairProb: null,
    edge: null,
    ev: null,
    confidence: "low",
    justification: "Computed from the model.",
    dataQuality: "model_only",
  },
  {
    match: "Bayern vs Hamburg",
    market: "BTTS",
    selection: "No",
    modelProb: 0.57,
    bookOdds: null,
    fairProb: null,
    edge: null,
    ev: null,
    confidence: "medium",
    justification: "Computed from the model.",
    dataQuality: "partial",
  },
];

describe("single best-pick selection", () => {
  it("returns no more than one highest-probability pick for each match", () => {
    const result = selectSingleBestPick(picks, { limit: 5 });
    expect(result).toHaveLength(2);
    expect(result.find((pick) => pick.match.startsWith("Arsenal"))?.selection).toBe("Over 1.5");
    expect(new Set(result.map((pick) => pick.match)).size).toBe(result.length);
  });

  it("filters to the requested market before choosing the fixture's single pick", () => {
    const result = selectSingleBestPick(picks, { targetMarket: "goals" });
    expect(result).toHaveLength(1);
    expect(result[0].selection).toBe("Over 1.5");
  });
});

describe("punter conversation intent", () => {
  it("opens the board only for explicit board requests", () => {
    expect(shouldOpenAnalysisBoard("show the analysis board")).toBe(true);
    expect(shouldOpenAnalysisBoard("give me the safest picks")).toBe(false);
  });

  it("recognizes match questions, follow-up markets, and general punter questions", async () => {
    expect(extractRequestedMatch("What's the safest play in Man Utd vs Brentford?")).toEqual({
      home: "Man Utd",
      away: "Brentford",
    });
    expect(extractTargetMarket("for correct score")).toBe("correct_score");
    expect(await classifyIntent("How should I structure a low-variance 3-fold?")).toBe("general");
    expect(await classifyIntent("For over/under")).toBe("analyse_match");
  });
});
