import { NextRequest, NextResponse } from "next/server";
import {
  createTelegramReplyMessages,
  sendTelegramChatAction,
  sendTelegramMessage,
  sendTelegramMessages,
  type TelegramMessage,
} from "@/lib/channels/telegram";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const processedUpdateIds = new Set<number>();
const MAX_PROCESSED_UPDATES = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTelegramMessage(value: unknown): TelegramMessage | undefined {
  if (!isRecord(value) || !isRecord(value.chat)) return undefined;
  const chatId = value.chat.id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return undefined;

  const photo = Array.isArray(value.photo)
    ? value.photo.filter((item): item is { file_id: string } =>
        isRecord(item) && typeof item.file_id === "string",
      )
    : undefined;
  return {
    chat: { id: chatId },
    text: typeof value.text === "string" ? value.text : undefined,
    photo,
  };
}

function rememberUpdate(updateId: number): void {
  processedUpdateIds.add(updateId);
  if (processedUpdateIds.size > MAX_PROCESSED_UPDATES) {
    const oldestUpdateId = processedUpdateIds.values().next().value;
    if (oldestUpdateId !== undefined) processedUpdateIds.delete(oldestUpdateId);
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "edgeai-telegram" });
}

export async function POST(request: NextRequest) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret || request.headers.get("x-telegram-bot-api-secret-token") !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON update." }, { status: 400 });
  }

  if (!isRecord(update) || typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id)) {
    return NextResponse.json({ error: "Invalid Telegram update." }, { status: 400 });
  }
  if (processedUpdateIds.has(update.update_id)) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  rememberUpdate(update.update_id);
  const message = parseTelegramMessage(update.message);
  if (!message) return NextResponse.json({ ok: true });

  const hasText = typeof message.text === "string" && message.text.trim().length > 0;
  const hasPhoto = (message.photo?.length ?? 0) > 0;
  if (!hasText && !hasPhoto) return NextResponse.json({ ok: true });

  try {
    await sendTelegramChatAction(message.chat.id);
    const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
    if (allowedChatId && String(message.chat.id) !== allowedChatId.trim()) {
      await sendTelegramMessage(message.chat.id, "Private EdgeAI bot.");
      return NextResponse.json({ ok: true });
    }

    await sendTelegramMessages(message.chat.id, await createTelegramReplyMessages(message));
    return NextResponse.json({ ok: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Could not process Telegram update.";
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
