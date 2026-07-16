// env.ts
// Shared helpers for reading and validating environment variables.
// Extracted so every service parses ADMIN_CHAT_ID the same way instead
// of duplicating (and subtly diverging) the same few lines.

// Returns the authorized admin chat ID, or null if it's unset or not a
// valid number. Guards against `Number("")` evaluating to 0 (a falsy
// env var must never be mistaken for a real chat id).
export function getAdminChatId(): number | null {
  const raw = process.env.ADMIN_CHAT_ID;
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
