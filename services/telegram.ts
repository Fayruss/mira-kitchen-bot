// telegram.ts
// Responsibility: talk to the Telegram Bot API.
// - parseUpdate: turn a raw webhook payload into a simple message shape
// - sendMessage: send a text reply to a chat

export type TelegramMessage = {
  chatId: number;
  text: string;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  return token;
}

// Extracts the chat id and text from a Telegram webhook update.
// Returns null if the update does not contain a plain text message
// (e.g. photos, stickers, edited messages, etc.).
export function parseUpdate(update: unknown): TelegramMessage | null {
  if (typeof update !== "object" || update === null) {
    return null;
  }

  const message = (update as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const chat = (message as { chat?: unknown }).chat;
  const text = (message as { text?: unknown }).text;

  const chatId = (chat as { id?: unknown } | undefined)?.id;

  if (typeof chatId !== "number" || typeof text !== "string") {
    return null;
  }

  return { chatId, text };
}

// Sends a text message to a Telegram chat.
export async function sendMessage(chatId: number, text: string): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}
