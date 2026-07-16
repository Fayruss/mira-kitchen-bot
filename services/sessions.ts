// sessions.ts
// Responsibility: load and save one conversation session per Telegram
// chat, backed by the conversation_sessions table in Supabase.

import { getSupabaseClient } from "@/lib/supabase";

const MAX_HISTORY_LENGTH = 5;
const TABLE = "conversation_sessions";

// Diagnostic logging only — does not affect control flow or the error
// that gets thrown afterwards. Logs enough to debug a failed
// session-load without ever logging the service role key itself.
function logSessionLoadError(context: string, error: unknown): void {
  console.error(`[sessions] ${context} — full error object:`, error);

  if (error && typeof error === "object" && "message" in error) {
    console.error(`[sessions] ${context} — error.message:`, (error as { message?: unknown }).message);
  }

  if (error && typeof error === "object" && "cause" in error) {
    console.error(`[sessions] ${context} — error.cause:`, (error as { cause?: unknown }).cause);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  console.error(
    `[sessions] ${context} — request URL:`,
    supabaseUrl ? `${supabaseUrl}/rest/v1/${TABLE}` : "(SUPABASE_URL not set)"
  );
  console.error(`[sessions] ${context} — SUPABASE_URL is set:`, Boolean(process.env.SUPABASE_URL));
  console.error(
    `[sessions] ${context} — SUPABASE_SERVICE_ROLE_KEY is set:`,
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

export type ConversationState =
  | "START"
  | "COLLECT_NAME"
  | "COLLECT_AREA"
  | "COLLECT_ITEMS"
  | "COLLECT_QUANTITY"
  | "CONFIRM_ORDER"
  | "COMPLETE"
  // Admin menu-management flows (/additem, /edititem, /removeitem).
  // These reuse the same conversation_sessions row and columns as the
  // customer order flow — no schema change, since `state` is a plain
  // text column with no DB-level constraint on its values. While in one
  // of these states, `orderItems` is repurposed to hold a small JSON
  // "draft" of the in-progress edit (see conversation.ts) instead of a
  // customer's order items — safe because a chat is either an admin
  // running a menu command or a customer placing an order, never both
  // at once.
  | "ADMIN_ADD_ITEM"
  | "ADMIN_EDIT_ITEM"
  | "ADMIN_REMOVE_ITEM";

export type Session = {
  chatId: number;
  state: ConversationState;
  history: string[];
  createdAt: string;
  updatedAt: string;
  // Order fields collected as the conversation moves through the state
  // machine. Saved into the orders table once the order is confirmed.
  customerName?: string;
  deliveryArea?: string;
  orderItems?: string;
  quantity?: string;
};

// Shape of a row as stored in Supabase (snake_case, nulls instead of
// undefined).
type SessionRow = {
  chat_id: number;
  state: ConversationState;
  history: string[];
  customer_name: string | null;
  delivery_area: string | null;
  order_items: string | null;
  quantity: string | null;
  created_at: string;
  updated_at: string;
};

function rowToSession(row: SessionRow): Session {
  return {
    chatId: row.chat_id,
    state: row.state,
    history: row.history ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    customerName: row.customer_name ?? undefined,
    deliveryArea: row.delivery_area ?? undefined,
    orderItems: row.order_items ?? undefined,
    quantity: row.quantity ?? undefined,
  };
}

// Returns the existing session for a chat, or creates a new one.
// Uses upsert with ignoreDuplicates so two concurrent first messages for
// the same brand-new chat (e.g. a duplicate Telegram webhook delivery)
// can't both try to insert the same primary key and throw — the loser
// of the race just re-selects the row the winner created.
export async function getOrCreateSession(chatId: number): Promise<Session> {
  const supabase = getSupabaseClient();

  let existing: unknown;
  let selectError: { message: string } | null;
  try {
    const result = await supabase
      .from(TABLE)
      .select("*")
      .eq("chat_id", chatId)
      .maybeSingle();
    existing = result.data;
    selectError = result.error;
  } catch (caughtError) {
    logSessionLoadError("initial session load threw", caughtError);
    throw caughtError;
  }

  if (selectError) {
    logSessionLoadError("initial session load returned an error", selectError);
    throw new Error(`Failed to load session: ${selectError.message}`);
  }

  if (existing) {
    return rowToSession(existing as SessionRow);
  }

  const { error: insertError } = await supabase
    .from(TABLE)
    .upsert({ chat_id: chatId, state: "START", history: [] }, { onConflict: "chat_id", ignoreDuplicates: true });

  if (insertError) {
    throw new Error(`Failed to create session: ${insertError.message}`);
  }

  // Re-select rather than trust the upsert's return value: if another
  // request won the race and created the row first, this fetches its
  // (possibly already-in-progress) state instead of overwriting it.
  let created: unknown;
  let refetchError: { message: string } | null;
  try {
    const result = await supabase
      .from(TABLE)
      .select("*")
      .eq("chat_id", chatId)
      .single();
    created = result.data;
    refetchError = result.error;
  } catch (caughtError) {
    logSessionLoadError("post-insert session reload threw", caughtError);
    throw caughtError;
  }

  if (refetchError) {
    logSessionLoadError("post-insert session reload returned an error", refetchError);
    throw new Error(`Failed to load session after creation: ${refetchError.message}`);
  }

  return rowToSession(created as SessionRow);
}

// Appends a user message to the session's history in memory, keeping
// only the most recent MAX_HISTORY_LENGTH messages. Call saveSession()
// afterwards to persist it.
export function addMessageToHistory(session: Session, text: string): void {
  session.history.push(text);
  if (session.history.length > MAX_HISTORY_LENGTH) {
    session.history.shift();
  }
}

// Persists the full session state to Supabase. Uses upsert (not update)
// so this can never silently no-op if the row happened to be missing —
// update() affects zero rows without erroring, which would lose the
// session state without any signal that something went wrong.
export async function saveSession(session: Session): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from(TABLE).upsert({
    chat_id: session.chatId,
    state: session.state,
    history: session.history,
    customer_name: session.customerName ?? null,
    delivery_area: session.deliveryArea ?? null,
    order_items: session.orderItems ?? null,
    quantity: session.quantity ?? null,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to save session: ${error.message}`);
  }
}
