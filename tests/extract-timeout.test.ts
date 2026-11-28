import { afterEach, describe, expect, it, vi } from "vitest";

const gemini = vi.hoisted(() => ({
  constructor: vi.fn(),
  generateContent: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: gemini.generateContent };

    constructor(options: unknown) {
      gemini.constructor(options);
    }
  },
}));

import { extractBetsFromImage } from "../lib/ai/extract";

describe("Gemini image extraction timeout", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("configures a Gemini request deadline of at least 10 seconds", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    gemini.generateContent.mockResolvedValue({ text: '{"bets":[]}' });

    await expect(extractBetsFromImage("AQID", "image/jpeg")).resolves.toEqual([]);

    expect(gemini.constructor).toHaveBeenCalledWith({
      apiKey: "test-key",
      httpOptions: { timeout: expect.any(Number) },
    });
    const options = gemini.constructor.mock.calls[0][0] as {
      httpOptions: { timeout: number };
    };
    expect(options.httpOptions.timeout).toBeGreaterThanOrEqual(10_000);
    expect(gemini.generateContent).toHaveBeenCalledOnce();
  });
});
