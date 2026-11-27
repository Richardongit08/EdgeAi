import { afterEach, describe, expect, it, vi } from "vitest";
import { recordTelegramUpdate, splitTelegramMessage } from "../lib/channels/telegram";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/telegram/route";

describe("Telegram webhook helpers", () => {
  it("deduplicates update ids", () => {
    const updateId = 987654321;
    expect(recordTelegramUpdate(updateId)).toBe(true);
    expect(recordTelegramUpdate(updateId)).toBe(false);
  });

  it("evicts old update ids when the deduplication set exceeds 500 entries", () => {
    const firstId = 700000000;
    for (let offset = 0; offset <= 500; offset += 1) {
      expect(recordTelegramUpdate(firstId + offset)).toBe(true);
    }
    expect(recordTelegramUpdate(firstId)).toBe(true);
    expect(recordTelegramUpdate(firstId + 500)).toBe(false);
  });

  it("splits long messages into safe chunks without losing content", () => {
    const text = `${"This is a long Telegram message. ".repeat(300)}⚽`;
    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

describe("Telegram webhook route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects requests with a mismatched webhook secret", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "expected-secret");
    const request = new NextRequest("http://localhost/api/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
      body: JSON.stringify({ update_id: 700000600 }),
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("sends typing before the welcome reply for an authenticated text message", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "expected-secret");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { action?: string; text?: string };
      methods.push(body.action ?? body.text ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const request = new NextRequest("http://localhost/api/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
      body: JSON.stringify({
        update_id: 700000601,
        message: { chat: { id: 123 }, text: "/start" },
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(methods[0]).toBe("typing");
    expect(methods[1]).toContain("Welcome to EdgeAI");
  });

  it("keeps the configured bot private to other chat ids", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "expected-secret");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_ALLOWED_CHAT_ID", "123");
    const texts: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text?: string };
      if (body.text) texts.push(body.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const request = new NextRequest("http://localhost/api/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "expected-secret" },
      body: JSON.stringify({
        update_id: 700000602,
        message: { chat: { id: 999 }, text: "/start" },
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(texts).toEqual(["Private EdgeAI bot."]);
  });
});
