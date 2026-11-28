import { NextRequest, NextResponse } from "next/server";
import {
  createTelegramReplyMessages,
  hasTelegramImage,
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
  const document = isRecord(value.document) && typeof value.document.file_id === "string"
    ? {
        file_id: value.document.file_id,
        mime_type: typeof value.document.mime_type === "string" ? value.document.mime_type : undefined,
      }
    : undefined;
  const replyValue = isRecord(value.reply_to_message) ? value.reply_to_message : undefined;
  const replyPhoto = Array.isArray(replyValue?.photo)
    ? replyValue.photo.filter((item): item is { file_id: string } =>
        isRecord(item) && typeof item.file_id === "string",
      )
    : undefined;
  const replyDocument = isRecord(replyValue?.document) &&
      typeof replyValue.document.file_id === "string"
    ? {
        file_id: replyValue.document.file_id,
        mime_type: typeof replyValue.document.mime_type === "string"
          ? replyValue.document.mime_type
          : undefined,
      }
    : undefined;
  return {
    chat: { id: chatId },
    text: typeof value.text === "string" ? value.text : undefined,
    caption: typeof value.caption === "string" ? value.caption : undefined,
    photo,
    document,
    reply_to_message: replyValue
      ? {
          caption: typeof replyValue.caption === "string" ? replyValue.caption : undefined,
          photo: replyPhoto,
          document: replyDocument,
        }
      : undefined,
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
  let chatId: number | string | undefined;
  try {
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

    chatId = message.chat.id;
    const hasText = typeof message.text === "string" && message.text.trim().length > 0;
    const hasImage = hasTelegramImage(message);
    if (!hasText && !hasImage) return NextResponse.json({ ok: true });

    const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
    if (allowedChatId && String(chatId) !== allowedChatId.trim()) {
      await sendTelegramMessage(chatId, "Private EdgeAI bot.");
      return NextResponse.json({ ok: true });
    }

    if (hasImage) {
      await sendTelegramMessage(chatId, "Analysing your bet slip...");
    } else {
      await sendTelegramChatAction(chatId);
    }
    await sendTelegramMessages(chatId, await createTelegramReplyMessages(message));
    return NextResponse.json({ ok: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Could not process Telegram update.";
    if (chatId !== undefined) {
      try {
        await sendTelegramMessage(chatId, "I couldn't process that message. Please try again.");
        return NextResponse.json({ ok: true });
      } catch (notificationError) {
        const notificationDetail = notificationError instanceof Error
          ? notificationError.message
          : "Could not notify the Telegram chat.";
        return NextResponse.json(
          { error: detail, notificationError: notificationDetail },
          { status: 500 },
        );
      }
    }
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
