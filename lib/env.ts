// env.ts
// Shared helpers for reading and validating environment variables.
// Extracted so every service parses admin IDs the same way instead
// of duplicating (and subtly diverging) the same few lines.

// Returns the authorized admin chat ID, or null if it's unset or not a
// valid number. Guards against `Number("")` evaluating to 0 (a falsy
// env var must never be mistaken for a real chat id).
//
// Legacy, single-admin form — kept for backward compatibility with
// existing deployments. New code should prefer getAdminChatIds().
export function getAdminChatId(): number | null {
  const raw = process.env.ADMIN_CHAT_ID;
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// Returns every authorized admin chat ID. Prefers ADMIN_IDS (a
// comma-separated list, e.g. "111111,222222"), so more than one person
// can administer the bot. Falls back to the legacy single
// ADMIN_CHAT_ID if ADMIN_IDS isn't set, so existing deployments keep
// working with zero config changes.
export function getAdminChatIds(): number[] {
  const raw = process.env.ADMIN_IDS;
  if (raw && raw.trim()) {
    return raw
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isFinite(id));
  }

  const legacy = getAdminChatId();
  return legacy !== null ? [legacy] : [];
}
