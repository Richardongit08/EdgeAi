import { NextRequest, NextResponse } from "next/server";
import {
  handleTelegramMessage,
  recordTelegramUpdate,
  sendTelegramMessage,
  type TelegramIncomingMessage,
} from "@/lib/channels/telegram";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTelegramMessage(value: unknown): value is TelegramIncomingMessage {
  return isRecord(value);
}

export async function POST(request: NextRequest) {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let update: Record<string, unknown>;
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) return NextResponse.json({ ok: true });
    update = body;
  } catch {
    return NextResponse.json({ error: "Invalid webhook payload." }, { status: 400 });
  }

  const updateId = update.update_id;
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId)) {
    return NextResponse.json({ ok: true });
  }
  if (!recordTelegramUpdate(updateId)) return NextResponse.json({ ok: true });

  if (!isTelegramMessage(update.message)) return NextResponse.json({ ok: true });
  const message = update.message;
  const chatId = isRecord(message.chat) ? message.chat.id : undefined;
  if (typeof chatId !== "number" && typeof chatId !== "string") {
    return NextResponse.json({ ok: true });
  }

  const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
  if (allowedChatId && String(chatId) !== allowedChatId) {
    try {
      await sendTelegramMessage(chatId, "Private EdgeAI bot.");
      return NextResponse.json({ ok: true });
    } catch (error) {
      const description = error instanceof Error ? error.message : "Could not send private-bot response.";
      return NextResponse.json({ error: description }, { status: 502 });
    }
  }

  try {
    await handleTelegramMessage(message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const description = error instanceof Error ? error.message : "Telegram update processing failed.";
    return NextResponse.json({ error: description }, { status: 502 });
  }
}
