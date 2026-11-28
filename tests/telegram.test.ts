import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractBetsFromImage } from "../lib/ai/extract";
import {
  createTelegramReplyMessages,
  formatBestPickMessages,
  formatBestPicks,
  selectHighestProbabilityPick,
  sendTelegramMessages,
  splitTelegramMessage,
} from "../lib/channels/telegram";
import { analyseFixtures } from "../lib/model/analyseFixtures";
import { selectBestPick, selectSingleBestPick } from "../lib/model/selectBestPick";
import { getUpcomingOddsFixtures } from "../lib/stats/oddsApi";
import { GET, POST } from "../src/app/api/telegram/route";
import type { ExtractedBet, Pick } from "../lib/stats/types";

vi.mock("../lib/ai/extract", () => ({
  extractBetsFromImage: vi.fn(),
}));

vi.mock("../lib/model/analyseFixtures", () => ({
  analyseFixtures: vi.fn(),
}));

vi.mock("../lib/stats/oddsApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/stats/oddsApi")>("../lib/stats/oddsApi");
  return { ...actual, getUpcomingOddsFixtures: vi.fn() };
});

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

function createSlipBets(count: number): ExtractedBet[] {
  return Array.from({ length: count }, (_, index) => ({
    home: `Home ${index}`,
    away: `Away ${index}`,
    market: "1X2",
    selection: `Home ${index}`,
    odds: 2.1 + index / 100,
  }));
}

function configureSlipAnalysis(bets: ExtractedBet[]): void {
  vi.mocked(extractBetsFromImage).mockResolvedValue(bets);
  vi.mocked(getUpcomingOddsFixtures).mockResolvedValue([]);
  vi.mocked(analyseFixtures).mockImplementation(async (fixtures) => {
    const fixture = fixtures[0];
    const bet = fixture?.confirmedBets?.[0];
    if (!fixture || !bet) return [];

    const index = Number(fixture.id.split("-").at(-1));
    const modelProb = 0.5 + index / 100;
    const bookOdds = bet.odds ?? null;
    const fairProb = bookOdds === null ? null : 1 / bookOdds;
    return [{
      ...pick(bet.selection, modelProb),
      match: `${fixture.home_team} vs ${fixture.away_team}`,
      market: bet.market,
      bookOdds,
      fairProb,
      edge: fairProb === null ? null : modelProb - fairProb,
      ev: bookOdds === null ? null : modelProb * bookOdds - 1,
    }];
  });
}

function stubTelegramImageDownload(contentType = "application/octet-stream"): string[] {
  const requestedUrls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    requestedUrls.push(url);
    if (url.includes("/getFile?file_id=")) {
      return new Response(JSON.stringify({
        ok: true,
        result: { file_path: "photos/slip.jpg" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/file/bot")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": contentType },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return requestedUrls;
}

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
    ], { targetMarket: "1x2", limit: 1 })).toEqual([probabilityTieHigherEv]);
    expect(selectSingleBestPick([highProbability, wrongMarket], { targetMarket: "all" })).toEqual([
      wrongMarket,
    ]);
  });

  it("analyses image documents using screenshot odds and the requested pick limit without live fixtures", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("ODDS_API_KEY", "");
    const requestedUrls = stubTelegramImageDownload("image/png; charset=binary");
    configureSlipAnalysis(createSlipBets(12));

    const messages = await createTelegramReplyMessages({
      chat: { id: 123 },
      document: { file_id: "direct-document", mime_type: "image/png" },
      caption: "Anluse this slip and give 10 best options",
    });

    expect(messages).toHaveLength(10);
    expect(messages[0].split("\n").slice(0, 4)).toEqual([
      "Match: Home 11 vs Away 11",
      "Probability: 61.0%",
      "Pick: Home 11",
      "odds: 2.21",
    ]);
    expect(requestedUrls[0]).toContain("file_id=direct-document");
    expect(extractBetsFromImage).toHaveBeenCalledWith("AQID", "image/png");
    expect(getUpcomingOddsFixtures).toHaveBeenCalledOnce();
    expect(analyseFixtures).toHaveBeenCalledTimes(12);
    expect(vi.mocked(analyseFixtures).mock.calls.map(([fixtures]) =>
      fixtures[0].confirmedBets?.[0].odds,
    )).toEqual(createSlipBets(12).map((bet) => bet.odds));
  });

  it("reads the largest photo when the image is attached to a replied-to message", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("ODDS_API_KEY", "");
    const requestedUrls = stubTelegramImageDownload("image/jpeg");
    configureSlipAnalysis(createSlipBets(1));

    const messages = await createTelegramReplyMessages({
      chat: { id: 123 },
      text: "Analyse this slip and give 1 best option",
      reply_to_message: {
        photo: [{ file_id: "reply-small" }, { file_id: "reply-large" }],
      },
    });

    expect(messages).toHaveLength(1);
    expect(requestedUrls[0]).toContain("file_id=reply-large");
    expect(extractBetsFromImage).toHaveBeenCalledWith("AQID", "image/jpeg");
    expect(messages[0]).toContain("Match: Home 0 vs Away 0");
  });

  it("reads replied-to image documents and uses the reply caption as instruction text", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("ODDS_API_KEY", "");
    const requestedUrls = stubTelegramImageDownload();
    configureSlipAnalysis(createSlipBets(1));

    const messages = await createTelegramReplyMessages({
      chat: { id: 123 },
      reply_to_message: {
        caption: "Give 1 best option",
        document: { file_id: "reply-document", mime_type: "image/webp" },
      },
    });

    expect(messages).toHaveLength(1);
    expect(requestedUrls[0]).toContain("file_id=reply-document");
    expect(extractBetsFromImage).toHaveBeenCalledWith("AQID", "image/webp");
  });

  it("reads direct photos and returns the specific response when no slip matches are extracted", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    const requestedUrls = stubTelegramImageDownload("image/jpeg");
    configureSlipAnalysis([]);

    const messages = await createTelegramReplyMessages({
      chat: { id: 123 },
      photo: [{ file_id: "small-photo" }, { file_id: "large-photo" }],
    });

    expect(messages).toEqual([
      "I couldn't read the team names clearly from that screenshot. Send a clearer or split screenshot and I'll rank the top options.",
    ]);
    expect(requestedUrls[0]).toContain("file_id=large-photo");
    expect(getUpcomingOddsFixtures).not.toHaveBeenCalled();
    expect(analyseFixtures).not.toHaveBeenCalled();
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
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
});
