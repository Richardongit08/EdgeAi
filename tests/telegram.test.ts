import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatBestPicks,
  selectHighestProbabilityPick,
  splitTelegramMessage,
} from "../lib/channels/telegram";
import { GET, POST } from "../src/app/api/telegram/route";
import type { Pick } from "../lib/stats/types";

const pick = (selection: string, modelProb: number): Pick => ({
  match: "Arsenal vs Chelsea",
  market: "1X2",
  selection,
  modelProb,
  bookOdds: 2.15,
  fairProb: 0.46,
  edge: modelProb - 0.46,
  ev: modelProb * 2.15 - 1,
  confidence: "medium",
  justification: "The model uses available team statistics.",
  dataQuality: "partial",
});

describe("Telegram reply helpers", () => {
  it("selects the highest-probability pick rather than the best-value pick", () => {
    const highProbability = pick("Double Chance", 0.72);
    const highValue = { ...pick("Away win", 0.3), ev: 0.8 };

    expect(selectHighestProbabilityPick([highValue, highProbability])).toBe(highProbability);
  });

  it("formats one pick with odds, chance, statistical justification, and disclaimer", () => {
    const reply = formatBestPicks([pick("Arsenal", 0.615)]);

    expect(reply).toContain("Match: Arsenal vs Chelsea");
    expect(reply).toContain("Arsenal (61.5% win/hit chance)");
    expect(reply).toContain("Decimal odds: 2.15");
    expect(reply).toContain("Statistical justification: The Poisson model");
    expect(reply.endsWith("Estimates only. No outcome is guaranteed. Gamble responsibly. 18+")).toBe(true);
  });

  it("splits long plain-text messages without exceeding Telegram's limit", () => {
    const message = `${"Match: Arsenal vs Chelsea\n".repeat(300)}Estimates only. No outcome is guaranteed.`;
    const chunks = splitTelegramMessage(message, 256);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 256)).toBe(true);
    expect(chunks.join("")).toBe(message);
  });

  it("reports the Telegram health check and rejects an unconfigured webhook secret", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    const health = await GET();
    const unauthorized = await POST(new NextRequest("https://edgeai.example/api/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "" },
      body: JSON.stringify({ update_id: 1 }),
    }));

    expect(await health.json()).toEqual({ ok: true, service: "edgeai-telegram" });
    expect(unauthorized.status).toBe(401);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
});
