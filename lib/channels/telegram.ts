import {
  extractPickLimit,
  extractRequestedMatch,
  extractTargetMarket,
  parseChatIntent,
} from "@/lib/ai/intent";
import { extractBetsFromImage } from "@/lib/ai/extract";
import {
  analyseAccumulator,
  analyseFixtures,
  type FixtureWithOdds,
} from "@/lib/model/analyseFixtures";
import type { AccumulatorResult } from "@/lib/model/buildAccumulator";
import { selectBestPick, selectSingleBestPick } from "@/lib/model/selectBestPick";
import { extractedBetSchema, type ExtractedBet, type Pick } from "@/lib/stats/types";
import {
  findOddsFixture,
  getSportKeyForLeague,
  getUpcomingOddsFixtures,
  type OddsFixture,
} from "@/lib/stats/oddsApi";

const DISCLAIMER = "Estimates only. No outcome is guaranteed. Gamble responsibly. 18+";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PICKS_PER_FIXTURE = 50;

export interface TelegramMessage {
  chat: { id: number | string };
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; mime_type?: string };
  reply_to_message?: {
    caption?: string;
    photo?: Array<{ file_id: string }>;
    document?: { file_id: string; mime_type?: string };
  };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramFile {
  file_path?: string;
}

interface TelegramImage {
  fileId: string;
  mimeType?: string;
}

const WELCOME_MESSAGE =
  "Welcome to EdgeAI. Send a football match query (for example, “Arsenal vs Chelsea”) or ask for the best plays. You can also upload a bet-slip screenshot for a leg-by-leg probability and value check.";

async function telegramApi<T>(method: string, init?: RequestInit): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as TelegramApiResponse<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description ?? `Telegram ${method} request failed.`);
  }
  return payload.result;
}

export async function sendTelegramChatAction(chatId: number | string): Promise<void> {
  await telegramApi("sendChatAction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

export function splitTelegramMessage(text: string, maxLength = 4096): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive integer.");
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength - 1);
    if (splitAt >= 0) {
      splitAt += 1;
    } else {
      splitAt = remaining.lastIndexOf(" ", maxLength - 1);
      if (splitAt >= 0) splitAt += 1;
    }
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
): Promise<void> {
  for (const chunk of splitTelegramMessage(text)) {
    await telegramApi("sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
  }
}

export async function sendTelegramMessages(
  chatId: number | string,
  messages: string[],
): Promise<void> {
  for (const message of messages) {
    await sendTelegramMessage(chatId, message);
  }
}

export function selectHighestProbabilityPick(picks: Pick[]): Pick | undefined {
  return selectBestPick(picks);
}

function formatMarketAndSelection(pick: Pick): { market: string; selection: string } {
  const market = pick.market.trim().replace(/_/g, " ");
  const normalizedMarket = market.toLowerCase();
  const selection = pick.selection.trim();
  const normalizedSelection = selection.toLowerCase();
  const [home, away] = pick.match.split(/\s+vs\s+/i);
  const picksSide = (team: string | undefined, side: "home" | "away") => {
    if (!team) return false;
    return new RegExp(`\\b${side}\\b`).test(normalizedSelection) ||
      new RegExp(`^${side === "home" ? "1" : "2"}(?:\\s*\\(|$)`).test(normalizedSelection) ||
      team.toLowerCase() === normalizedSelection ||
      normalizedSelection.includes(team.toLowerCase());
  };

  if (normalizedMarket.includes("btts") || normalizedMarket.includes("both teams")) {
    return { market: "BTTS", selection };
  }
  if (normalizedMarket.includes("double chance")) {
    const outcome = /^(?:1x\b|home\s*(?:or|and)\s*draw|draw\s*(?:or|and)\s*home)/.test(normalizedSelection)
      ? "1X (Home or Draw)"
      : /^(?:x2\b|away\s*(?:or|and)\s*draw|draw\s*(?:or|and)\s*away)/.test(normalizedSelection)
        ? "X2 (Draw or Away)"
        : /^(?:12\b|home\s*(?:or|and)\s*away|away\s*(?:or|and)\s*home)/.test(normalizedSelection)
          ? "12 (Home or Away)"
          : selection;
    return { market: "Double Chance", selection: outcome };
  }
  if (
    normalizedMarket === "1x2" ||
    normalizedMarket === "h2h" ||
    normalizedMarket.includes("match result") ||
    normalizedMarket.includes("match winner") ||
    normalizedMarket.includes("full time result")
  ) {
    const outcome = /2up/.test(normalizedSelection) && /\bhome\b/.test(normalizedSelection)
      ? "Home Win (1) / 2UP"
      : /2up/.test(normalizedSelection) && /\baway\b/.test(normalizedSelection)
        ? "Away Win (2) / 2UP"
        : /draw|tie|^x$/.test(normalizedSelection)
      ? "Draw (X)"
      : picksSide(home, "home")
        ? `Home Win (${home})`
        : picksSide(away, "away")
          ? `Away Win (${away})`
          : selection;
    return { market: "1X2", selection: outcome };
  }
  if (
    normalizedMarket.includes("2nd half") ||
    normalizedMarket.includes("second half")
  ) {
    return { market: "2nd Half Total Goals", selection };
  }
  if (normalizedMarket.includes("team total") || normalizedMarket.includes("team goals")) {
    const team = market.replace(/team total goals|team goals/ig, "").trim();
    return {
      market: "Team Total Goals",
      selection: `${team ? `${team} ` : ""}${selection.replace(/\s+goals?$/i, "")}`,
    };
  }
  if (
    normalizedMarket.includes("goals over/under") ||
    normalizedMarket === "totals" ||
    normalizedMarket.includes("total goals") ||
    normalizedMarket.includes("total goal")
  ) {
    return { market: "Total Goals", selection: selection.replace(/\s+goals?$/i, "") };
  }
  if (normalizedMarket.includes("handicap") || normalizedMarket.includes("spread")) {
    const handicap = selection.match(/[+-]\s*\d+(?:\.\d+)?/)?.[0].replace(/\s/g, "");
    const team = picksSide(home, "home") ? home : picksSide(away, "away") ? away : undefined;
    return {
      market: "Handicap",
      selection: team && handicap ? `${team} ${handicap}` : selection,
    };
  }
  if (normalizedMarket.includes("correct score")) return { market: "Correct Score", selection };
  if (normalizedMarket.includes("corner")) {
    return { market: "Corners", selection: selection.replace(/\s+corners?$/i, "") };
  }
  if (normalizedMarket.includes("shot")) {
    return { market: "Shots", selection: selection.replace(/\s+shots?$/i, "") };
  }
  return { market, selection };
}

export function formatBestPickMessages(picks: Pick[]): string[] {
  return picks.map((pick, index) => {
    const formattedPick = formatMarketAndSelection(pick);
    const message = [
      `Match: ${pick.match}`,
      `Probability: ${(pick.modelProb * 100).toFixed(1)}%`,
      `Pick: ${formattedPick.market} — ${formattedPick.selection}`,
      `odds: ${(pick.bookOdds !== null && Number.isFinite(pick.bookOdds) && pick.bookOdds > 1
        ? pick.bookOdds
        : 1 / Math.min(Math.max(pick.modelProb, 0.0001), 1)).toFixed(2)}`,
    ].join("\n");
    return index === picks.length - 1 ? `${message}\n\n${DISCLAIMER}` : message;
  });
}

export function formatBestPicks(picks: Pick[]): string {
  return formatBestPickMessages(picks).join("\n\n");
}

function plainReply(message: string): string[] {
  return [message];
}

async function textReply(text: string): Promise<string[]> {
  if (isHelpCommand(text)) return plainReply(WELCOME_MESSAGE);

  const parsedIntent = await parseChatIntent(text);
  const intent = parsedIntent.intent;
  if (intent === "general" || intent === "explain_pick") {
    return plainReply("Ask for the best plays or name a match (Team A vs Team B). You can also upload a bet-slip screenshot for analysis.");
  }

  const targetMarket = extractTargetMarket(text);
  const fixtureLimit = parsedIntent.gameCount ?? extractPickLimit(text) ?? 6;
  const fixtures = await getUpcomingOddsFixtures();
  if (intent === "analyse_match") {
    const requestedMatch = extractRequestedMatch(text);
    if (!requestedMatch) return plainReply("Name the match in the format Team A vs Team B.");
    const fixture = findOddsFixture(fixtures, requestedMatch.home, requestedMatch.away);
    if (!fixture) {
      return plainReply(`I couldn't match ${requestedMatch.home} vs ${requestedMatch.away} to an upcoming fixture with live odds.`);
    }
    const picks = await analyseFixtures([fixture], { limit: MAX_PICKS_PER_FIXTURE });
    const bestPick = selectHighestProbabilityPick(picks);
    return bestPick
      ? formatBestPickMessages([bestPick])
      : plainReply("No statistical picks are available for that match right now.");
  }

  if (targetMarket !== "all") {
    if (fixtures.length === 0) return plainReply("No upcoming fixtures are scheduled in the next 36 hours.");
    const marketPicks = await analyseFixtures(fixtures, {
      limit: fixtureLimit,
      singleBestPerMatch: true,
      targetMarket,
    });
    return marketPicks.length
      ? formatBestPickMessages(marketPicks)
      : plainReply("No picks are available for that market in the next 36 hours.");
  }

  const accumulatorRequested = parsedIntent.gameCount !== undefined ||
    parsedIntent.targetTotalOdds !== undefined ||
    parsedIntent.riskProfile !== "balanced";
  if (accumulatorRequested) {
    if (fixtures.length === 0) {
      return plainReply("No upcoming fixtures are scheduled in the next 36 hours.");
    }
    const accumulator = await analyseAccumulator(fixtures, {
      ...(parsedIntent.gameCount !== undefined
        ? { gameCount: parsedIntent.gameCount }
        : parsedIntent.targetTotalOdds === undefined
          ? { gameCount: fixtureLimit }
          : {}),
      ...(parsedIntent.targetTotalOdds !== undefined
        ? { targetTotalOdds: parsedIntent.targetTotalOdds }
        : {}),
      riskProfile: parsedIntent.riskProfile,
    });
    if (!accumulator.reachedTarget || accumulator.legs.length === 0) {
      return plainReply("I couldn't build an accumulator meeting the requested game count and odds target from available picks.");
    }
    return formatAccumulatorMessages(accumulator);
  }

  const upcomingFixtures = fixtures.slice(0, fixtureLimit);
  if (upcomingFixtures.length === 0) {
    return plainReply("No upcoming fixtures are scheduled in the next 36 hours.");
  }

  const picksByFixture = await Promise.all(upcomingFixtures.map((fixture) =>
    analyseFixtures([fixture], { limit: MAX_PICKS_PER_FIXTURE }),
  ));
  const bestPicks = picksByFixture
    .map(selectHighestProbabilityPick)
    .filter((pick): pick is Pick => pick !== undefined);
  return bestPicks.length
    ? formatBestPickMessages(bestPicks)
    : plainReply("No statistical picks are available for the upcoming fixtures right now.");
}

function formatAccumulatorMessages(accumulator: AccumulatorResult): string[] {
  const legMessages = formatBestPickMessages(accumulator.legs).map((message) =>
    message.endsWith(`\n\n${DISCLAIMER}`)
      ? message.slice(0, -(`\n\n${DISCLAIMER}`).length)
      : message,
  );
  const summary = [
    `Legs: ${accumulator.legs.length}`,
    `Target Odds: ${accumulator.targetTotalOdds?.toString() ?? "not set"}`,
    `Combined Accumulator Odds: ${accumulator.combinedOdds.toFixed(2)}`,
  ].join(" | ");
  if (accumulator.targetTotalOdds !== undefined || accumulator.riskProfile === "multi_combo") {
    return [...legMessages, `${summary}\n\n${DISCLAIMER}`];
  }
  return [...legMessages, DISCLAIMER];
}

function isHelpCommand(text: string): boolean {
  return /^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function fixtureForBet(bet: ExtractedBet, fixtures: OddsFixture[], index: number): FixtureWithOdds {
  const fixture = findOddsFixture(fixtures, bet.home, bet.away);
  return fixture
    ? { ...fixture, confirmedBets: [bet] }
    : {
        id: `telegram-screenshot-${index}`,
        sport_key: getSportKeyForLeague(bet.league),
        commence_time: bet.date ?? new Date().toISOString(),
        home_team: bet.home,
        away_team: bet.away,
        bookmakers: [],
        confirmedBets: [bet],
      };
}

function isImageDocument(document: TelegramMessage["document"]): boolean {
  return document !== undefined && (
    document.mime_type?.startsWith("image/") === true ||
    document.mime_type === "application/octet-stream"
  );
}

function getTelegramImages(message: TelegramMessage): TelegramImage[] {
  const photo = message.photo?.at(-1);
  if (photo) return [{ fileId: photo.file_id }];

  const document = message.document;
  if (document && isImageDocument(document)) {
    return [{ fileId: document.file_id, mimeType: document.mime_type }];
  }

  const replyPhoto = message.reply_to_message?.photo?.at(-1);
  if (replyPhoto) return [{ fileId: replyPhoto.file_id }];

  const replyDocument = message.reply_to_message?.document;
  if (replyDocument && isImageDocument(replyDocument)) {
    return [{ fileId: replyDocument.file_id, mimeType: replyDocument.mime_type }];
  }
  return [];
}

export function hasTelegramImage(message: TelegramMessage): boolean {
  return getTelegramImages(message).length > 0;
}

function resolveTelegramImageMimeType(documentMimeType: string | undefined, filePath: string): string {
  const declaredMimeType = documentMimeType?.split(";")[0].trim().toLowerCase();
  if (
    declaredMimeType === "image/jpeg" ||
    declaredMimeType === "image/png" ||
    declaredMimeType === "image/webp"
  ) return declaredMimeType;
  if (/\.png$/i.test(filePath)) return "image/png";
  if (/\.webp$/i.test(filePath)) return "image/webp";
  return "image/jpeg";
}

async function downloadTelegramImage(
  telegramImage: TelegramImage,
): Promise<{ base64Image: string; mimeType: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const file = await telegramApi<TelegramFile>(
    `getFile?file_id=${encodeURIComponent(telegramImage.fileId)}`,
  );
  if (!file.file_path) throw new Error("Telegram did not return an image file path.");

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Could not download the Telegram image.");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error("Bet-slip images must be smaller than 10 MB.");
  }
  const image = await response.arrayBuffer();
  if (image.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Bet-slip images must be smaller than 10 MB.");
  }
  return {
    base64Image: Buffer.from(image).toString("base64"),
    mimeType: resolveTelegramImageMimeType(telegramImage.mimeType, file.file_path),
  };
}

function normalizedFixtureKey(bet: ExtractedBet): string {
  const normalizeTeam = (team: string) =>
    team.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return `${normalizeTeam(bet.home)} vs ${normalizeTeam(bet.away)}`;
}

async function photoReply(
  telegramImages: TelegramImage[],
  instructionText: string,
): Promise<string[]> {
  const images = await Promise.all(telegramImages.map(downloadTelegramImage));
  const bets = extractedBetSchema.array().parse(
    images.length === 1
      ? await extractBetsFromImage(images[0].base64Image, images[0].mimeType)
      : await extractBetsFromImage(images),
  );
  if (bets.length === 0) {
    return plainReply("I couldn't read the team names clearly from that screenshot. Send it as an uncompressed File or split it into 2 shorter screenshots and I'll rank the top options.");
  }

  const seenFixtures = new Set<string>();
  const uniqueBets = bets.filter((bet) => {
    const key = normalizedFixtureKey(bet);
    if (seenFixtures.has(key)) return false;
    seenFixtures.add(key);
    return true;
  });
  const availableFixtures = await getUpcomingOddsFixtures();
  const fixtureBets = uniqueBets.map((bet, index) => fixtureForBet(bet, availableFixtures, index));
  const analyses = await Promise.all(fixtureBets.map((fixture) =>
    analyseFixtures([fixture], { limit: MAX_PICKS_PER_FIXTURE }),
  ));
  const scoredPicks = uniqueBets.flatMap((bet, index) => {
    const fixture = fixtureBets[index];
    const matchName = `${fixture.home_team} vs ${fixture.away_team}`;
    const pick = analyses[index].find((candidate) =>
      candidate.match === matchName &&
      candidate.market.toLowerCase() === bet.market.toLowerCase() &&
      candidate.selection.toLowerCase() === bet.selection.toLowerCase(),
    );
    return pick ? [pick] : [];
  });
  if (scoredPicks.length === 0) {
    return plainReply("I couldn't calculate probabilities for the extracted matches.");
  }

  const limit = extractPickLimit(instructionText) ?? 10;
  const rankedPicks = selectSingleBestPick(scoredPicks)
    .sort((a, b) => b.modelProb - a.modelProb)
    .slice(0, limit);
  return formatBestPickMessages(rankedPicks);
}

export async function createTelegramReplyMessages(
  messageOrMessages: TelegramMessage | TelegramMessage[],
): Promise<string[]> {
  const messages = Array.isArray(messageOrMessages) ? messageOrMessages : [messageOrMessages];
  const images = messages.flatMap(getTelegramImages);
  if (images.length > 0) {
    const instructionText = messages
      .map((message) => message.caption || message.text || message.reply_to_message?.caption || "")
      .find((text) => text.length > 0) ?? "";
    return photoReply(images, instructionText);
  }
  const message = messages[0];
  if (typeof message.text === "string" && message.text.trim()) {
    return textReply(message.text.trim());
  }
  return plainReply("Send a football match question or upload a bet-slip screenshot.");
}

export async function createTelegramReply(message: TelegramMessage): Promise<string> {
  return (await createTelegramReplyMessages(message)).join("\n\n");
}
