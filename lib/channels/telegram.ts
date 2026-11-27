import {
  classifyIntent,
  extractPickLimit,
  extractRequestedMatch,
  extractTargetMarket,
  normalizeFootballQuestion,
  type RequestedMatch,
} from "@/lib/ai/intent";
import { extractBetsFromImage } from "@/lib/ai/extract";
import { answerPunterQuestion } from "@/lib/ai/punterChat";
import { analyseFixtures, type FixtureWithOdds } from "@/lib/model/analyseFixtures";
import {
  findOddsFixture,
  getUpcomingOddsFixtures,
  getSportKeyForLeague,
  type OddsFixture,
} from "@/lib/stats/oddsApi";
import type { ExtractedBet, Pick } from "@/lib/stats/types";

const seenUpdateIds = new Set<number>();
const lastFixtureByChat = new Map<string, RequestedMatch>();
const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const RESPONSIBLE_FOOTER = "Estimates only. No outcome is guaranteed. Gamble responsibly. 18+.";

interface TelegramPhoto {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramIncomingMessage {
  chat?: { id?: number | string };
  text?: string;
  photo?: TelegramPhoto[];
}

interface TelegramFileResponse {
  ok?: boolean;
  description?: string;
  result?: { file_path?: string; file_size?: number };
}

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  return token;
}

export function recordTelegramUpdate(updateId: number): boolean {
  if (!Number.isSafeInteger(updateId) || seenUpdateIds.has(updateId)) return false;
  seenUpdateIds.add(updateId);
  if (seenUpdateIds.size > 500) {
    const oldest = seenUpdateIds.values().next().value as number | undefined;
    if (oldest !== undefined) seenUpdateIds.delete(oldest);
  }
  return true;
}

export function splitTelegramMessage(text: string, limit = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  if (!text) return [];
  const points = Array.from(text);
  const chunks: string[] = [];
  while (points.length > 0) {
    let length = 0;
    let end = 0;
    while (end < points.length && length + points[end].length <= limit) {
      length += points[end].length;
      end += 1;
    }
    if (end === 0) end = 1;
    if (end < points.length) {
      let whitespace = end - 1;
      while (whitespace > 0 && !/\s/.test(points[whitespace])) whitespace -= 1;
      if (whitespace > 0) end = whitespace + 1;
    }
    chunks.push(points.splice(0, end).join(""));
  }
  return chunks;
}

async function telegramRequest(method: string, body: Record<string, unknown>): Promise<unknown> {
  const token = getBotToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Telegram ${method} request failed (${response.status}).`);
  const payload = await response.json() as { ok?: boolean; description?: string };
  if (payload.ok !== true) throw new Error(`Telegram ${method} failed: ${payload.description ?? "unknown error"}`);
  return payload;
}

export async function sendTelegramChatAction(chatId: number | string, action: "typing"): Promise<void> {
  await telegramRequest("sendChatAction", { chat_id: chatId, action });
}

export async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
  for (const chunk of splitTelegramMessage(text)) {
    await telegramRequest("sendMessage", { chat_id: chatId, text: chunk });
  }
}

function welcomeMessage(): string {
  return [
    "Welcome to EdgeAI — your football stats and punter co-pilot.",
    "Ask for the safest available picks, analyse a match, or specify a market such as goals, BTTS, 1X2, or correct score.",
    "Send a bet-slip screenshot for a leg-by-leg probability and edge check.",
    RESPONSIBLE_FOOTER,
  ].join("\n\n");
}

function mentionMatches(fixtures: OddsFixture[], text: string): OddsFixture[] {
  const normalized = normalizeFootballQuestion(text).toLowerCase();
  const words = normalized.split(/[^a-z0-9]+/);
  const mentions = (name: string) => {
    const tokens = normalizeFootballQuestion(name).toLowerCase().split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !["the", "fc", "cf", "afc", "sc"].includes(token));
    const first = tokens[0];
    return tokens.length > 0 && (
      tokens.every((token) => normalized.includes(token)) ||
      (first.length >= 5 && words.includes(first))
    );
  };
  return fixtures.flatMap((fixture) => {
    const home = mentions(fixture.home_team);
    const away = mentions(fixture.away_team);
    return home || away ? [{ fixture, both: home && away }] : [];
  }).sort((a, b) => Number(b.both) - Number(a.both) ||
    Date.parse(a.fixture.commence_time) - Date.parse(b.fixture.commence_time))
    .slice(0, 3)
    .map(({ fixture }) => fixture);
}

function firstStatsSentence(pick: Pick): string {
  return pick.justification.split(". ")[0].replace(/[.!?]+$/, "");
}

export function formatTelegramPicks(picks: Pick[]): string {
  const lines = picks.map((pick, index) => [
    `${index + 1}. ${pick.match}`,
    `Pick: ${pick.selection} — ${(pick.modelProb * 100).toFixed(1)}% (highest model probability)`,
    `Odds: ${pick.bookOdds === null ? "@ Model Fair (no live price)" : `@ ${pick.bookOdds.toFixed(2)}`}`,
    `Stats: ${firstStatsSentence(pick)}; data quality ${pick.dataQuality}.`,
  ].join("\n"));
  return `${lines.join("\n\n")}\n\n${RESPONSIBLE_FOOTER}`;
}

function explainNoPicks(fixtureCount: number): string {
  return fixtureCount === 0
    ? `No upcoming fixtures with usable odds are available in the next 36 hours.\n\n${RESPONSIBLE_FOOTER}`
    : `No grounded pick is available: fetched team statistics are insufficient for the requested market.\n\n${RESPONSIBLE_FOOTER}`;
}

async function replyToText(chatId: number | string, text: string): Promise<void> {
  const command = text.trim().split(/\s+/, 1)[0].toLowerCase().replace(/@[^@]+$/, "");
  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(chatId, welcomeMessage());
    return;
  }

  const intent = await classifyIntent(text);
  const lastFixture = lastFixtureByChat.get(String(chatId));
  const requestedMatch = extractRequestedMatch(text) ?? lastFixture;
  const targetMarket = extractTargetMarket(text);
  const limit = extractPickLimit(text) ?? 5;

  if (intent === "open_board") {
    await sendTelegramMessage(chatId, `The full Analysis Board is available in the EdgeAI web chat. Here, ask for a fixture or slate pick.\n\n${RESPONSIBLE_FOOTER}`);
    return;
  }

  const fixtures = await getUpcomingOddsFixtures();
  let selectedFixtures: OddsFixture[] = [];
  if (intent === "best_plays") {
    selectedFixtures = fixtures;
  } else if (intent === "analyse_match") {
    if (!requestedMatch) {
      await sendTelegramMessage(chatId, `Name the fixture as Team A vs Team B, or ask about a fixture from earlier in this chat.\n\n${RESPONSIBLE_FOOTER}`);
      return;
    }
    const fixture = findOddsFixture(fixtures, requestedMatch.home, requestedMatch.away);
    if (!fixture) {
      await sendTelegramMessage(chatId, `I couldn't match ${requestedMatch.home} vs ${requestedMatch.away} to an upcoming fixture in the 36-hour window.\n\n${RESPONSIBLE_FOOTER}`);
      return;
    }
    selectedFixtures = [fixture];
    lastFixtureByChat.set(String(chatId), { home: fixture.home_team, away: fixture.away_team });
  } else {
    selectedFixtures = mentionMatches(fixtures, text);
  }

  const picks = selectedFixtures.length > 0
    ? await analyseFixtures(selectedFixtures, {
        limit: intent === "best_plays" ? limit : Math.max(1, selectedFixtures.length),
        singleBestPerMatch: true,
        targetMarket,
      })
    : [];
  if (intent !== "best_plays" && intent !== "analyse_match") {
    if (picks.length > 0) {
      const fixture = selectedFixtures[0];
      lastFixtureByChat.set(String(chatId), { home: fixture.home_team, away: fixture.away_team });
      await sendTelegramMessage(chatId, formatTelegramPicks(picks));
    } else {
      await sendTelegramMessage(chatId, `${await answerPunterQuestion(text, [])}\n\n${RESPONSIBLE_FOOTER}`);
    }
    return;
  }
  await sendTelegramMessage(chatId, picks.length > 0
    ? formatTelegramPicks(picks)
    : explainNoPicks(selectedFixtures.length));
}

function getImageMimeType(filePath: string, contentType: string | null): string {
  const accepted = ["image/jpeg", "image/png", "image/webp"];
  const headerType = contentType?.split(";")[0].trim().toLowerCase();
  if (headerType && accepted.includes(headerType)) return headerType;
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  throw new Error("Telegram returned an unsupported image format.");
}

async function fetchTelegramPhoto(photo: TelegramPhoto): Promise<{ base64: string; mimeType: string }> {
  const token = getBotToken();
  const fileResponse = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(photo.file_id)}`,
    { cache: "no-store", signal: AbortSignal.timeout(10000) },
  );
  if (!fileResponse.ok) throw new Error(`Telegram getFile failed (${fileResponse.status}).`);
  const filePayload = await fileResponse.json() as TelegramFileResponse;
  const filePath = filePayload.result?.file_path;
  if (filePayload.ok !== true || !filePath) {
    throw new Error(`Telegram getFile failed: ${filePayload.description ?? "file path is unavailable"}`);
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[?#\\]/.test(segment))) {
    throw new Error("Telegram returned an invalid image path.");
  }
  if ((filePayload.result?.file_size ?? photo.file_size ?? 0) > MAX_PHOTO_BYTES) {
    throw new Error("The screenshot must be smaller than 10 MB.");
  }

  const url = `https://api.telegram.org/file/bot${token}/${segments.map(encodeURIComponent).join("/")}`;
  const imageResponse = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!imageResponse.ok) throw new Error(`Telegram image download failed (${imageResponse.status}).`);
  const contentLength = Number(imageResponse.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PHOTO_BYTES) {
    throw new Error("The screenshot must be smaller than 10 MB.");
  }
  const bytes = await imageResponse.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) {
    throw new Error("The screenshot must be a non-empty image smaller than 10 MB.");
  }
  const mimeType = getImageMimeType(filePath, imageResponse.headers.get("content-type"));
  return { base64: Buffer.from(bytes).toString("base64"), mimeType };
}

function sameFixture(pick: Pick, fixture: OddsFixture): boolean {
  return pick.match.toLowerCase() === `${fixture.home_team} vs ${fixture.away_team}`.toLowerCase();
}

function marketFamily(market: string): string {
  const value = market.toLowerCase();
  if (/correct\s*score/.test(value)) return "correct_score";
  if (/shot/.test(value)) return "total_shots";
  if (/btts|both\s+teams/.test(value)) return "btts";
  if (/double\s+chance/.test(value)) return "double_chance";
  if (/draw\s+no\s+bet|\bdnb\b/.test(value)) return "draw_no_bet";
  if (/handicap|spread/.test(value)) return "asian_handicap";
  if (/1x2|\bh2h\b|match\s+(?:result|winner)/.test(value)) return "1x2";
  if (/goal|over|under|total/.test(value)) return "goals";
  return value;
}

function normalizeSelection(selection: string): string {
  return selection.toLowerCase()
    .replace(/\b(?:goals?|shots?)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findLegPick(picks: Pick[], bet: ExtractedBet, fixture: OddsFixture): Pick | undefined {
  return picks.find((pick) =>
    sameFixture(pick, fixture) &&
    pick.dataQuality !== "limited" &&
    marketFamily(pick.market) === marketFamily(bet.market) &&
    normalizeSelection(pick.selection) === normalizeSelection(bet.selection),
  );
}

async function replyToPhoto(chatId: number | string, photos: TelegramPhoto[]): Promise<void> {
  if (photos.length === 0) {
    await sendTelegramMessage(chatId, `No screenshot was attached.\n\n${RESPONSIBLE_FOOTER}`);
    return;
  }
  const photo = [...photos].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (photo.file_size !== undefined && photo.file_size > MAX_PHOTO_BYTES) {
    await sendTelegramMessage(chatId, `The screenshot must be smaller than 10 MB.\n\n${RESPONSIBLE_FOOTER}`);
    return;
  }

  const { base64, mimeType } = await fetchTelegramPhoto(photo);
  const bets = await extractBetsFromImage(base64, mimeType);
  if (bets.length === 0) {
    await sendTelegramMessage(chatId, `No football bets could be extracted from that screenshot.\n\n${RESPONSIBLE_FOOTER}`);
    return;
  }

  const availableFixtures = await getUpcomingOddsFixtures();
  const fixturesWithBets: Array<{ bet: ExtractedBet; fixture: FixtureWithOdds }> = bets.map((bet, index) => {
    const availableFixture = findOddsFixture(availableFixtures, bet.home, bet.away);
    const fixture: FixtureWithOdds = availableFixture ?? {
      id: `telegram-slip-${index}`,
      sport_key: getSportKeyForLeague(bet.league),
      commence_time: bet.date ?? new Date().toISOString(),
      home_team: bet.home,
      away_team: bet.away,
      bookmakers: [],
    };
    return { bet, fixture: { ...fixture, confirmedBets: [bet] } };
  });
  const picks = await analyseFixtures(fixturesWithBets.map(({ fixture }) => fixture), { limit: 50 });
  const lines = fixturesWithBets.map(({ bet, fixture }, index) => {
    const pick = findLegPick(picks, bet, fixture);
    if (!pick) {
      return [
        `${index + 1}. ${fixture.home_team} vs ${fixture.away_team}`,
        `Leg: ${bet.selection} — probability unavailable`,
        `Odds: ${bet.odds ? `@ ${bet.odds.toFixed(2)}` : "not shown"}`,
        "Edge: unavailable because the market or supporting team statistics could not be verified.",
      ].join("\n");
    }
    const edge = pick.edge === null
      ? "unavailable (no bookmaker price)"
      : `${pick.edge >= 0 ? "+" : ""}${(pick.edge * 100).toFixed(1)}% vs implied probability`;
    return [
      `${index + 1}. ${pick.match}`,
      `Leg: ${bet.selection} — ${(pick.modelProb * 100).toFixed(1)}%`,
      `Odds: ${pick.bookOdds === null ? "@ Model Fair" : `@ ${pick.bookOdds.toFixed(2)}`}`,
      `Edge: ${edge}`,
      `Stats: ${firstStatsSentence(pick)}; data quality ${pick.dataQuality}.`,
    ].join("\n");
  });
  const response = `Bet-slip leg check\n\n${lines.join("\n\n")}\n\n${RESPONSIBLE_FOOTER}`;
  await sendTelegramMessage(chatId, response);
}

export async function handleTelegramMessage(message: TelegramIncomingMessage): Promise<void> {
  const chatId = message.chat?.id;
  if (chatId === undefined || chatId === null) return;
  const hasText = typeof message.text === "string" && message.text.trim().length > 0;
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  if (!hasText && !hasPhoto) return;

  await sendTelegramChatAction(chatId, "typing");
  if (hasPhoto) {
    await replyToPhoto(chatId, message.photo ?? []);
  } else if (hasText) {
    await replyToText(chatId, message.text!.trim());
  }
}
