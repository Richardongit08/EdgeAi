import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatBestPickMessages,
  formatBestPicks,
  selectHighestProbabilityPick,
  sendTelegramMessages,
  splitTelegramMessage,
} from "../lib/channels/telegram";
import { selectBestPick, selectSingleBestPick } from "../lib/model/selectBestPick";
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

  it("formats picks as separate four-line messages with numeric odds", () => {
    const secondPick = {
      ...pick("Under 2.5", 0.62),
      match: "Liverpool vs Brighton",
      bookOdds: null,
    };
    const messages = formatBestPickMessages([pick("Arsenal", 0.615), secondPick]);
    const reply = formatBestPicks([pick("Arsenal", 0.615)]);

    expect(messages).toHaveLength(2);
    expect(messages[0].split("\n")).toEqual([
      "Match: Arsenal vs Chelsea",
      "Probability: 61.5%",
      "Pick: Arsenal",
      "odds: 2.15",
    ]);
    expect(messages[1].split("\n").slice(0, 4)).toEqual([
      "Match: Liverpool vs Brighton",
      "Probability: 62.0%",
      "Pick: Under 2.5",
      "odds: 1.61",
    ]);
    expect(messages[0]).not.toContain("Statistical justification:");
    expect(messages[1]).not.toContain("Statistical justification:");
    expect(messages[0]).not.toContain("18+");
    expect(messages[1].endsWith("Estimates only. No outcome is guaranteed. Gamble responsibly. 18+")).toBe(true);
    expect(reply).not.toContain("Unavailable");
    expect(reply).not.toContain("Statistical justification:");
    expect(reply.endsWith("Estimates only. No outcome is guaranteed. Gamble responsibly. 18+")).toBe(true);
  });

  it("prefers priced picks only within the high-probability candidates", () => {
    const unpricedHighProbability = { ...pick("Home", 0.78), bookOdds: null };
    const pricedHighProbability = { ...pick("Double Chance", 0.65), bookOdds: 1.45 };
    const pricedLowProbability = { ...pick("Away", 0.42), bookOdds: 2.8 };

    expect(selectBestPick([
      unpricedHighProbability,
      pricedHighProbability,
      pricedLowProbability,
    ])).toBe(pricedHighProbability);
  });

  it("selects one highest-probability pick per match, with market and limit options", () => {
    const highProbability = pick("Home", 0.72);
    const probabilityTieHigherEv = { ...pick("Draw", 0.72), ev: 0.6 };
    const otherMatch = { ...pick("Away", 0.65), match: "Liverpool vs Brighton" };
    const wrongMarket = { ...pick("Over 2.5", 0.95), market: "Goals Over/Under 2.5" };

    expect(selectSingleBestPick([
      pick("Home", 0.61),
      highProbability,
      probabilityTieHigherEv,
      otherMatch,
      wrongMarket,
    ], { targetMarket: "1X2", limit: 1 })).toEqual([probabilityTieHigherEv]);
    expect(selectSingleBestPick([highProbability, wrongMarket], { targetMarket: "all" })).toEqual([
      wrongMarket,
    ]);
  });

  it("sends a batch as sequential, separate Telegram messages", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    const sentMessages: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      sentMessages.push(body.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }), {
        status: 200,
      });
    });

    await sendTelegramMessages(123, ["first pick", "second pick"]);

    expect(sentMessages).toEqual(["first pick", "second pick"]);
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
