import { classifyIntent, extractPickLimit, extractRequestedMatch } from "@/lib/ai/intent";
import { extractBetsFromImage } from "@/lib/ai/extract";
import { analyseFixtures, type FixtureWithOdds } from "@/lib/model/analyseFixtures";
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

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, init);
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

export function formatBestPickMessages(picks: Pick[]): string[] {
  return picks.map((pick, index) => {
    const message = [
      `Match: ${pick.match}`,
      `Probability: ${(pick.modelProb * 100).toFixed(1)}%`,
      `Pick: ${pick.selection}`,
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

  const intent = await classifyIntent(text);
  if (intent === "general" || intent === "explain_pick") {
    return plainReply("Ask for the best plays or name a match (Team A vs Team B). You can also upload a bet-slip screenshot for analysis.");
  }

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

  const fixtureLimit = extractPickLimit(text) ?? 6;
  const upcomingFixtures = fixtures.slice(0, fixtureLimit);
  if (upcomingFixtures.length === 0) {
    return plainReply("No upcoming fixtures with odds are available to analyse. Check ODDS_API_KEY and try again.");
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

function getTelegramImage(message: TelegramMessage): TelegramImage | undefined {
  const photo = message.photo?.at(-1);
  if (photo) return { fileId: photo.file_id };

  const document = message.document;
  if (document?.mime_type?.startsWith("image/")) {
    return { fileId: document.file_id, mimeType: document.mime_type };
  }

  const replyPhoto = message.reply_to_message?.photo?.at(-1);
  if (replyPhoto) return { fileId: replyPhoto.file_id };

  const replyDocument = message.reply_to_message?.document;
  if (replyDocument?.mime_type?.startsWith("image/")) {
    return { fileId: replyDocument.file_id, mimeType: replyDocument.mime_type };
  }
}

async function photoReply(
  telegramImage: TelegramImage,
  instructionText: string,
): Promise<string[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const file = await telegramApi<TelegramFile>(
    `getFile?file_id=${encodeURIComponent(telegramImage.fileId)}`,
  );
  if (!file.file_path) throw new Error("Telegram did not return an image file path.");

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    cache: "no-store",
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

  const responseMimeType = response.headers.get("content-type")?.split(";")[0];
  const mimeType = responseMimeType?.startsWith("image/")
    ? responseMimeType
    : telegramImage.mimeType ?? "image/jpeg";
  const bets = extractedBetSchema.array().parse(
    await extractBetsFromImage(Buffer.from(image).toString("base64"), mimeType),
  );
  if (bets.length === 0) {
    return plainReply("I couldn't read the team names clearly from that screenshot. Send a clearer or split screenshot and I'll rank the top options.");
  }

  const availableFixtures = await getUpcomingOddsFixtures();
  const fixtureBets = bets.map((bet, index) => fixtureForBet(bet, availableFixtures, index));
  const analyses = await Promise.all(fixtureBets.map((fixture) =>
    analyseFixtures([fixture], { limit: MAX_PICKS_PER_FIXTURE }),
  ));
  const scoredPicks = bets.flatMap((bet, index) => {
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
  const rankedPicks = selectSingleBestPick(scoredPicks, { limit });
  return formatBestPickMessages(rankedPicks);
}

export async function createTelegramReplyMessages(message: TelegramMessage): Promise<string[]> {
  const image = getTelegramImage(message);
  if (image) {
    const instructionText = message.caption || message.text || message.reply_to_message?.caption || "";
    return photoReply(image, instructionText);
  }
  if (typeof message.text === "string" && message.text.trim()) {
    return textReply(message.text.trim());
  }
  return plainReply("Send a football match question or upload a bet-slip screenshot.");
}

export async function createTelegramReply(message: TelegramMessage): Promise<string> {
  return (await createTelegramReplyMessages(message)).join("\n\n");
}
