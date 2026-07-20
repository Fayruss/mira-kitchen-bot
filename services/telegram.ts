// telegram.ts
// Responsibility: talk to the Telegram Bot API.
// - parseUpdate: turn a raw webhook payload into a simple message shape
// - sendMessage: send a plain text reply to a chat
// - sendMessageWithKeyboard: send a reply with a custom keyboard
//   attached (or removed) — used for Admin Mode's button menu

export type TelegramMessage = {
  chatId: number;
  text: string;
};

// Telegram's ReplyKeyboardMarkup: a persistent custom keyboard shown
// under the chat's text input. Tapping a button just sends its label
// back as an ordinary text message — no new update type to handle.
export type ReplyKeyboardMarkup = {
  keyboard: string[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
};

// Hides a previously-shown ReplyKeyboardMarkup.
export type ReplyKeyboardRemove = {
  remove_keyboard: true;
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

// Shared by sendMessage and sendMessageWithKeyboard so the fetch/error
// handling can't drift out of sync between them.
async function postMessage(payload: Record<string, unknown>): Promise<void> {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}

// Sends a text message to a Telegram chat.
export async function sendMessage(chatId: number, text: string): Promise<void> {
  await postMessage({ chat_id: chatId, text });
}

// Sends a text message with a custom reply keyboard attached (or
// removed). Used for Admin Mode's button menu.
export async function sendMessageWithKeyboard(
  chatId: number,
  text: string,
  replyMarkup: ReplyKeyboardMarkup | ReplyKeyboardRemove
): Promise<void> {
  await postMessage({ chat_id: chatId, text, reply_markup: replyMarkup });
}
