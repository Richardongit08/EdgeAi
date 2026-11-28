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
import { analyseAccumulator, analyseFixtures } from "../lib/model/analyseFixtures";
import { selectBestPick, selectSingleBestPick } from "../lib/model/selectBestPick";
import { getUpcomingOddsFixtures, type OddsFixture } from "../lib/stats/oddsApi";
import { GET, POST } from "../src/app/api/telegram/route";
import type { ExtractedBet, Pick } from "../lib/stats/types";

vi.mock("../lib/ai/extract", () => ({
  extractBetsFromImage: vi.fn(),
}));

vi.mock("../lib/model/analyseFixtures", () => ({
  analyseAccumulator: vi.fn(),
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

function stubTelegramImageDownload(
  contentType = "application/octet-stream",
  filePath = "photos/slip.jpg",
): string[] {
  const requestedUrls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    requestedUrls.push(url);
    if (url.includes("/getFile?file_id=")) {
      return new Response(JSON.stringify({
        ok: true,
        result: { file_path: filePath },
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

function stubTelegramWebhookFetch(): { sentMessages: string[]; requestedUrls: string[] } {
  const sentMessages: string[] = [];
  const requestedUrls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    requestedUrls.push(url);
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body)) as { text: string };
      sentMessages.push(body.text);
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: sentMessages.length },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
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
        headers: { "content-type": "application/octet-stream" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { sentMessages, requestedUrls };
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
      market: "Goals Over/Under 2.5",
      bookOdds: null,
    };
    const messages = formatBestPickMessages([pick("Arsenal", 0.615), secondPick]);
    const reply = formatBestPicks([pick("Arsenal", 0.615)]);

    expect(messages).toHaveLength(2);
    expect(messages[0].split("\n")).toEqual([
      "Match: Arsenal vs Chelsea",
      "Probability: 61.5%",
      "Pick: 1X2 — Home Win (Arsenal)",
      "odds: 2.15",
    ]);
    expect(messages[1].split("\n").slice(0, 4)).toEqual([
      "Match: Liverpool vs Brighton",
      "Probability: 62.0%",
      "Pick: Total Goals — Under 2.5",
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

  it("formats explicit markets for common Telegram pick types", () => {
    const formatted = [
      { market: "BTTS", selection: "Yes", expected: "Pick: BTTS — Yes" },
      { market: "Double Chance", selection: "12", expected: "Pick: Double Chance — 12 (Home or Away)" },
      { market: "1X2", selection: "Draw", expected: "Pick: 1X2 — Draw (X)" },
      { market: "1X2", selection: "Home Win (Arsenal) / 2UP", expected: "Pick: 1X2 — Home Win (1) / 2UP" },
      { market: "Goals Over/Under 2.5", selection: "Over 2.5", expected: "Pick: Total Goals — Over 2.5" },
      { market: "Asian Handicap", selection: "Home (+1.5)", expected: "Pick: Handicap — Arsenal +1.5" },
      { market: "Correct Score", selection: "1-1", expected: "Pick: Correct Score — 1-1" },
      { market: "Corners", selection: "Over 9.5", expected: "Pick: Corners — Over 9.5" },
      { market: "Total Shots", selection: "Over 22.5 Shots", expected: "Pick: Shots — Over 22.5" },
      { market: "Maccabi Tel Aviv FC Team Total Goals", selection: "Under 3.5 Goals", expected: "Pick: Team Total Goals — Maccabi Tel Aviv FC Under 3.5" },
      { market: "2nd Half Total Goals", selection: "Over 0.5 Goals", expected: "Pick: 2nd Half Total Goals — Over 0.5 Goals" },
    ].map(({ market, selection }) =>
      formatBestPickMessages([{ ...pick(selection, 0.7), market }])[0].split("\n")[2],
    );

    expect(formatted).toEqual([
      "Pick: BTTS — Yes",
      "Pick: Double Chance — 12 (Home or Away)",
      "Pick: 1X2 — Draw (X)",
      "Pick: 1X2 — Home Win (1) / 2UP",
      "Pick: Total Goals — Over 2.5",
      "Pick: Handicap — Arsenal +1.5",
      "Pick: Correct Score — 1-1",
      "Pick: Corners — Over 9.5",
      "Pick: Shots — Over 22.5",
      "Pick: Team Total Goals — Maccabi Tel Aviv FC Under 3.5",
      "Pick: 2nd Half Total Goals — Over 0.5 Goals",
    ]);
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
      "Pick: 1X2 — Home Win (Home 11)",
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

  it("uses the file extension when Telegram responds with application/octet-stream", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    const requestedUrls = stubTelegramImageDownload("application/octet-stream", "photos/slip.png");
    configureSlipAnalysis([{
      home: "SportyBet Home",
      away: "SportyBet Away",
      market: "Goals Over/Under 3.5",
      selection: "Under 3.5",
      odds: 1.26,
    }]);

    const messages = await createTelegramReplyMessages({
      chat: { id: 123 },
      document: { file_id: "sportybet-slip", mime_type: "application/octet-stream" },
    });

    expect(messages).toHaveLength(1);
    expect(requestedUrls[0]).toContain("file_id=sportybet-slip");
    expect(extractBetsFromImage).toHaveBeenCalledWith("AQID", "image/png");
    expect(vi.mocked(analyseFixtures).mock.calls[0][0][0].confirmedBets?.[0]).toMatchObject({
      market: "Goals Over/Under 3.5",
      selection: "Under 3.5",
      odds: 1.26,
    });
  });

  it("scores tipster screenshot picks when odds are absent and ranks by probability", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("ODDS_API_KEY", "");
    stubTelegramImageDownload();
    const bets: ExtractedBet[] = [
      { home: "Home 0", away: "Away 0", market: "1X2", selection: "Home 0" },
      { home: "Home 1", away: "Away 1", market: "BTTS", selection: "Yes" },
      { home: "Home 2", away: "Away 2", market: "Double Chance", selection: "1X" },
    ];
    configureSlipAnalysis(bets);

    const messages = await createTelegramReplyMessages({
      chat: { id: 123 },
      photo: [{ file_id: "tipster-image" }],
    });

    expect(messages[0]).toContain("Match: Home 2 vs Away 2");
    expect(messages.map((message) => Number(message.match(/Probability: ([\d.]+)%/)?.[1])))
      .toEqual([52, 51, 50]);
    expect(vi.mocked(analyseFixtures).mock.calls.map(([fixtures]) =>
      fixtures[0].confirmedBets?.[0].odds,
    )).toEqual([undefined, undefined, undefined]);
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
      "I couldn't read the team names clearly from that screenshot. Send it as an uncompressed File or split it into 2 shorter screenshots and I'll rank the top options.",
    ]);
    expect(requestedUrls[0]).toContain("file_id=large-photo");
    expect(getUpcomingOddsFixtures).not.toHaveBeenCalled();
    expect(analyseFixtures).not.toHaveBeenCalled();
  });

  it("filters and limits Telegram picks for numbered market-game requests", async () => {
    const fixtures: OddsFixture[] = [{
      id: "market-fixture",
      sport_key: "soccer_epl",
      commence_time: "2026-12-01T19:00:00Z",
      home_team: "Arsenal",
      away_team: "Chelsea",
      bookmakers: [],
    }];
    const queries = [
      ["6 correct score games", "correct_score", "Correct Score", "1-0", 6],
      ["5 over/under games", "goals", "Goals Over/Under 2.5", "Over 2.5", 5],
      ["4 btts games", "btts", "BTTS", "Yes", 4],
      ["3 total shots games", "total_shots", "Total Shots", "Over 22.5 Shots", 3],
      ["5 double chance games", "double_chance", "Double Chance", "1X", 5],
    ] as const;

    for (const [query, targetMarket, market, selection, limit] of queries) {
      vi.mocked(getUpcomingOddsFixtures).mockResolvedValue(fixtures);
      vi.mocked(analyseFixtures).mockResolvedValue([{
        ...pick(selection, 0.72),
        market,
      }]);

      const messages = await createTelegramReplyMessages({
        chat: { id: 123 },
        text: query,
      });

      expect(analyseFixtures).toHaveBeenCalledWith(fixtures, {
        limit,
        singleBestPerMatch: true,
        targetMarket,
      });
      expect(messages).toHaveLength(1);
      const formattedMarkets: Record<string, string> = {
        "BTTS": "BTTS",
        "Double Chance": "Double Chance",
        "Correct Score": "Correct Score",
        "Total Shots": "Shots",
        "Goals Over/Under 2.5": "Total Goals",
      };
      const doubleChanceSelections: Record<string, string> = {
        "1X": "1X (Home or Draw)",
        "X2": "X2 (Draw or Away)",
        "12": "12 (Home or Away)",
      };
      const formattedSelection = market === "Double Chance"
        ? doubleChanceSelections[selection] ?? selection
        : market === "Total Shots"
          ? selection.replace(/\s+shots?$/i, "")
          : selection;
      expect(messages[0].split("\n").slice(0, 4)).toEqual([
        "Match: Arsenal vs Chelsea",
        "Probability: 72.0%",
        `Pick: ${formattedMarkets[market] ?? "1X2"} — ${formattedSelection}`,
        "odds: 2.15",
      ]);
      vi.clearAllMocks();
    }
  });

  it("sends multi-combo legs as separate messages followed by an accumulator summary", async () => {
    const fixtures: OddsFixture[] = [{
      id: "multi-combo-fixture",
      sport_key: "soccer_epl",
      commence_time: "2026-12-01T19:00:00Z",
      home_team: "Arsenal",
      away_team: "Chelsea",
      bookmakers: [],
    }];
    const legs = Array.from({ length: 6 }, (_, index) => ({
      ...pick(`Selection ${index}`, 0.7 - index / 100),
      match: `Home ${index} vs Away ${index}`,
      market: index % 2 ? "1X2" : "Double Chance",
      bookOdds: index % 2 ? 2 : 1.4,
    }));
    const combinedOdds = legs.reduce((total, leg) => total * (leg.bookOdds ?? 1), 1);
    vi.mocked(getUpcomingOddsFixtures).mockResolvedValue(fixtures);
    vi.mocked(analyseAccumulator).mockResolvedValue({
      legs,
      combinedOdds,
      gameCount: 6,
      riskProfile: "multi_combo",
      reachedTarget: true,
    });

    const messages = await createTelegramReplyMessages({
      chat: { id: 123 },
      text: "6 multi combo games",
    });

    expect(analyseAccumulator).toHaveBeenCalledWith(fixtures, {
      gameCount: 6,
      riskProfile: "multi_combo",
    });
    expect(messages).toHaveLength(7);
    expect(messages.slice(0, 6).every((message) => message.split("\n").length === 4)).toBe(true);
    expect(messages[6]).toContain(
      `Legs: 6 | Target Odds: not set | Combined Accumulator Odds: ${combinedOdds.toFixed(2)}`,
    );
  });

  it("acknowledges and analyzes a replied-to image document from a Telegram webhook", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("ODDS_API_KEY", "");
    const { sentMessages, requestedUrls } = stubTelegramWebhookFetch();
    configureSlipAnalysis(createSlipBets(1));

    const response = await POST(new NextRequest("https://edgeai.example/api/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 712034,
        message: {
          chat: { id: 123 },
          text: "5 correct score games",
          reply_to_message: {
            caption: "Analyse this slip",
            document: { file_id: "reply-document", mime_type: "image/png" },
          },
        },
      }),
    }));

    expect(response.status).toBe(200);
    expect(sentMessages[0]).toBe("Analysing your bet slip...");
    expect(sentMessages[1]).toContain("Match: Home 0 vs Away 0");
    expect(requestedUrls.some((url) => url.includes("file_id=reply-document"))).toBe(true);
    expect(extractBetsFromImage).toHaveBeenCalledWith("AQID", "image/png");
  });

  it("buffers Telegram media groups, sends one acknowledgment, and deduplicates fixtures", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("ODDS_API_KEY", "");
    const { sentMessages } = stubTelegramWebhookFetch();
    configureSlipAnalysis([
      { home: "Arsenal", away: "Chelsea", market: "1X2", selection: "Arsenal", odds: 1.8 },
      { home: " arsenal ", away: "CHELSEA!", market: "BTTS", selection: "Yes" },
      { home: "Liverpool", away: "Brighton", market: "BTTS", selection: "Yes" },
    ]);
    const request = (updateId: number, fileId: string) => new NextRequest(
      "https://edgeai.example/api/telegram",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "test-secret",
        },
        body: JSON.stringify({
          update_id: updateId,
          message: {
            chat: { id: 123 },
            media_group_id: "album-123",
            photo: [{ file_id: fileId }],
          },
        }),
      },
    );

    const responses = await Promise.all([
      POST(request(712036, "album-photo-1")),
      POST(request(712037, "album-photo-2")),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(sentMessages.filter((message) => message === "Analysing your bet slip...")).toHaveLength(1);
    expect(extractBetsFromImage).toHaveBeenCalledOnce();
    expect(vi.mocked(extractBetsFromImage).mock.calls[0][0]).toEqual([
      { base64Image: "AQID", mimeType: "image/jpeg" },
      { base64Image: "AQID", mimeType: "image/jpeg" },
    ]);
    expect(analyseFixtures).toHaveBeenCalledTimes(2);
    expect(sentMessages.filter((message) => message.startsWith("Match:"))).toHaveLength(2);
  });

  it("notifies the chat if Telegram image processing throws", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    const { sentMessages } = stubTelegramWebhookFetch();
    vi.mocked(extractBetsFromImage).mockRejectedValue(new Error("vision request failed"));

    const response = await POST(new NextRequest("https://edgeai.example/api/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 712035,
        message: {
          chat: { id: 123 },
          document: { file_id: "broken-image", mime_type: "image/jpeg" },
        },
      }),
    }));

    expect(response.status).toBe(200);
    expect(sentMessages).toEqual([
      "Analysing your bet slip...",
      "I couldn't process that message: vision request failed",
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
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
});
