// conversation.ts
// Responsibility: the Conversation Engine.
//
// Routes an incoming message to a reply. /start always resets first.
// Admin commands are handled next: /open, /close, /menu are single-shot;
// /additem, /edititem, /removeitem are guided, multi-step flows (see the
// "Admin menu management" section below) that read/write the existing
// menu_items table — no SQL, Supabase, or code required from Mira.
// Otherwise, for a normal customer message:
//
//   1. A handful of deterministic, Gemini-free checks first (cancel,
//      bare numbers, yes/no at confirmation, plain greetings on a fresh
//      session) — see tryDeterministicResponse().
//   2. Anything else goes to Gemini ONCE per message
//      (services/gemini.ts's extractOrderInfo) to extract whichever of
//      {customerName, deliveryArea, items, quantity} the message
//      states, plus an optional natural-language reply if it contains
//      a question or small talk.
//   3. Extracted fields are merged into the session (always overwriting
//      — this is what makes corrections like "actually make it fried
//      rice" work without special-casing).
//   4. Whichever of the 4 fields is still missing determines the next
//      prompt; if none are missing, the confirmation summary is shown.
//
// `ConversationState` (COLLECT_NAME/COLLECT_AREA/...) is preserved as
// bookkeeping that mirrors whichever field is currently missing, rather
// than as the thing that decides what a message means — the state
// machine still exists, it's just no longer in the driver's seat.
//
// On confirmation, saves the order (services/orders.ts) and notifies
// the admin, then clears the session's order fields.

import { Session, ConversationState } from "./sessions";
import { isKitchenOpen, openKitchen, closeKitchen } from "./availability";
import { saveOrder, notifyAdmin } from "./orders";
import { getMenuText, listMenuItems, addMenuItem, updateMenuItem, deleteMenuItem, MenuItem } from "./menu";
import { getAdminChatId } from "@/lib/env";
import { extractOrderInfo, ExtractedOrderInfo, ExtractionContext } from "./gemini";

const ADMIN_COMMANDS = ["/open", "/close", "/menu", "/additem", "/edititem", "/removeitem"];

export function isAdminCommand(text: string): boolean {
  return ADMIN_COMMANDS.includes(text.trim().toLowerCase());
}

function isAuthorizedAdmin(chatId: number): boolean {
  const adminChatId = getAdminChatId();
  return adminChatId !== null && chatId === adminChatId;
}

async function handleAdminCommand(session: Session, text: string): Promise<string> {
  if (!isAuthorizedAdmin(session.chatId)) {
    return "Sorry, you're not authorized to use admin commands.";
  }

  switch (text.trim().toLowerCase()) {
    case "/open":
      await openKitchen();
      return "Kitchen is now OPEN. Customers can place orders.";

    case "/close":
      await closeKitchen();
      return "Kitchen is now CLOSED. Customers cannot place new orders.";

    case "/menu":
      return await getMenuText();

    case "/additem":
      return startAddItemFlow(session);

    case "/edititem":
      return startEditItemFlow(session);

    case "/removeitem":
      return startRemoveItemFlow(session);

    default:
      return "Unknown admin command.";
  }
}

const WELCOME_MESSAGE = "Welcome to Mira's Kitchen! What's your name?";

function isStartCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/start";
}

function isAffirmative(text: string): boolean {
  return /^(yes|y|yeah|yep|sure|confirm)\b/i.test(text.trim());
}

function isNegative(text: string): boolean {
  return /^(no|n|nope|nah|edit|change)\b/i.test(text.trim());
}

function isCancelWord(text: string): boolean {
  return ["cancel", "cancel order", "cancel my order"].includes(text.trim().toLowerCase());
}

function isBareNumber(text: string): boolean {
  return /^\d+$/.test(text.trim());
}

// A quantity of 0 (or anything non-positive) isn't a real order —
// reject it explicitly rather than let it silently reach confirmation.
function isValidQuantity(text: string): boolean {
  const parsed = parseInt(text.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0;
}

// Plain greetings, checked only on a completely fresh session (nothing
// collected yet) — replaces the old hardcoded START-state greeting
// without spending a Gemini call on the single most common opening
// message.
const SIMPLE_GREETINGS = new Set([
  "hi", "hello", "hey", "hiya", "yo", "hi there", "hello there",
  "good morning", "good afternoon", "good evening",
]);

// ---------------------------------------------------------------------
// Admin menu management: /additem, /edititem, /removeitem
//
// These are guided, one-question-at-a-time flows — Mira never has to
// remember a command syntax, just answer plain questions. Progress is
// kept across messages by reusing this same admin chat's session row:
// `state` becomes one of the ADMIN_* values, and `orderItems` (unused
// for an admin running a menu command, since they're not placing a
// customer order) holds a small JSON "draft" of the in-progress edit.
// No new table or column — see the ADMIN_* comment on ConversationState
// in sessions.ts.
// ---------------------------------------------------------------------

type AddItemDraft = {
  step: "name" | "price" | "available";
  name?: string;
  price?: number;
};

type EditableField = "name" | "price" | "available";

type EditItemDraft = {
  step: "select" | "field" | "value";
  items: MenuItem[];
  itemId?: string;
  itemName?: string;
  field?: EditableField;
};

type RemoveItemDraft = {
  step: "select" | "confirm";
  items: MenuItem[];
  itemId?: string;
  itemName?: string;
};

const ADMIN_MENU_FLOW_STATES: ConversationState[] = ["ADMIN_ADD_ITEM", "ADMIN_EDIT_ITEM", "ADMIN_REMOVE_ITEM"];

function isAdminMenuFlowState(state: ConversationState): boolean {
  return ADMIN_MENU_FLOW_STATES.includes(state);
}

// The draft is stored as a JSON string in session.orderItems purely as
// scratch space — parse failures are treated the same as "no draft",
// which resets the flow rather than crashing on corrupted data.
function getAdminDraft<T>(session: Session): T | null {
  if (!session.orderItems) {
    return null;
  }
  try {
    return JSON.parse(session.orderItems) as T;
  } catch {
    return null;
  }
}

function setAdminDraft(session: Session, draft: unknown): void {
  session.orderItems = JSON.stringify(draft);
}

function clearAdminDraft(session: Session): void {
  session.orderItems = undefined;
}

function formatSelectableList(items: MenuItem[]): string {
  return items
    .map((item, index) => `${index + 1}. ${item.name} — $${item.price}${item.available ? "" : " (unavailable)"}`)
    .join("\n");
}

// Accepts plain numbers, with or without a currency symbol/commas
// (e.g. "$1500", "1,500"), so Mira doesn't have to type it in one exact
// format.
function parsePriceInput(text: string): number | null {
  const cleaned = text.trim().replace(/[^0-9.]/g, "");
  if (!cleaned) {
    return null;
  }
  const value = parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeFieldName(text: string): EditableField | null {
  const lower = text.trim().toLowerCase();
  if (lower === "name") return "name";
  if (lower === "price" || lower === "cost") return "price";
  if (lower === "availability" || lower === "available") return "available";
  return null;
}

// Loads menu items for an admin flow, returning null (rather than
// throwing) on a Supabase hiccup so the flow can give a clear, friendly
// error instead of crashing.
async function listMenuItemsForAdmin(): Promise<MenuItem[] | null> {
  try {
    return await listMenuItems();
  } catch (error) {
    console.error("Failed to load menu items for admin flow:", error);
    return null;
  }
}

// Small message-template helpers shared across the three admin flows,
// so the wording (and any future tweak to it) can't drift out of sync
// between /additem, /edititem, and /removeitem.
function menuLoadFailedMessage(command: string): string {
  return `Sorry, I couldn't load the menu right now. Please try ${command} again in a moment.`;
}

function draftLostMessage(command: string): string {
  return `Something went wrong with that — let's start over. Send ${command} to try again.`;
}

function saveFailedMessage(action: string, command: string): string {
  return `Sorry, something went wrong ${action} that item. Please try ${command} again.`;
}

function startAddItemFlow(session: Session): string {
  clearOrderFields(session);
  session.state = "ADMIN_ADD_ITEM";
  setAdminDraft(session, { step: "name" } satisfies AddItemDraft);
  return 'Let\'s add a new menu item. What\'s the name? (Reply "cancel" anytime to stop.)';
}

async function startEditItemFlow(session: Session): Promise<string> {
  const items = await listMenuItemsForAdmin();
  if (items === null) {
    return menuLoadFailedMessage("/edititem");
  }
  if (items.length === 0) {
    return "The menu is empty right now — use /additem to add the first item.";
  }
  clearOrderFields(session);
  session.state = "ADMIN_EDIT_ITEM";
  setAdminDraft(session, { step: "select", items } satisfies EditItemDraft);
  return `Which item would you like to edit? Reply with the number.\n${formatSelectableList(items)}\n\n(Reply "cancel" anytime to stop.)`;
}

async function startRemoveItemFlow(session: Session): Promise<string> {
  const items = await listMenuItemsForAdmin();
  if (items === null) {
    return menuLoadFailedMessage("/removeitem");
  }
  if (items.length === 0) {
    return "The menu is already empty — nothing to remove.";
  }
  clearOrderFields(session);
  session.state = "ADMIN_REMOVE_ITEM";
  setAdminDraft(session, { step: "select", items } satisfies RemoveItemDraft);
  return `Which item would you like to remove? Reply with the number.\n${formatSelectableList(items)}\n\n(Reply "cancel" anytime to stop.)`;
}

function selectFromList(items: MenuItem[], text: string): MenuItem | null {
  const index = parseInt(text.trim(), 10);
  if (!Number.isFinite(index) || index < 1 || index > items.length) {
    return null;
  }
  return items[index - 1];
}

async function continueAddItemFlow(session: Session, text: string): Promise<string> {
  const draft = getAdminDraft<AddItemDraft>(session);
  if (!draft) {
    session.state = "START";
    return draftLostMessage("/additem");
  }

  if (draft.step === "name") {
    if (!text.trim()) {
      return "What's the name of the new item?";
    }
    draft.name = text.trim();
    draft.step = "price";
    setAdminDraft(session, draft);
    return `Got it — "${draft.name}". What's the price? (just the number, e.g. 1500)`;
  }

  if (draft.step === "price") {
    const price = parsePriceInput(text);
    if (price === null) {
      return "Please reply with just the price as a number, e.g. 1500.";
    }
    draft.price = price;
    draft.step = "available";
    setAdminDraft(session, draft);
    return `Is "${draft.name}" available right now? (yes/no)`;
  }

  // draft.step === "available"
  if (!isAffirmative(text) && !isNegative(text)) {
    return 'Please reply "yes" or "no" — is it available right now?';
  }
  const available = isAffirmative(text);
  const { name, price } = draft;

  try {
    await addMenuItem(name!, price!, available);
  } catch (error) {
    console.error("Failed to add menu item:", error);
    clearAdminDraft(session);
    session.state = "START";
    return saveFailedMessage("saving", "/additem");
  }

  clearAdminDraft(session);
  session.state = "START";
  return `Added "${name}" — $${price}${available ? "" : " (unavailable)"}. Reply /menu to see the full list.`;
}

async function continueEditItemFlow(session: Session, text: string): Promise<string> {
  const draft = getAdminDraft<EditItemDraft>(session);
  if (!draft) {
    session.state = "START";
    return draftLostMessage("/edititem");
  }

  if (draft.step === "select") {
    const chosen = selectFromList(draft.items, text);
    if (!chosen) {
      return `Please reply with a number between 1 and ${draft.items.length}.`;
    }
    draft.itemId = chosen.id;
    draft.itemName = chosen.name;
    draft.step = "field";
    setAdminDraft(session, draft);
    return `What would you like to change for "${chosen.name}"? Reply: name, price, or availability.`;
  }

  if (draft.step === "field") {
    const field = normalizeFieldName(text);
    if (!field) {
      return 'Please reply "name", "price", or "availability".';
    }
    draft.field = field;
    draft.step = "value";
    setAdminDraft(session, draft);
    if (field === "name") return `What's the new name for "${draft.itemName}"?`;
    if (field === "price") return `What's the new price for "${draft.itemName}"?`;
    return `Should "${draft.itemName}" be available? (yes/no)`;
  }

  // draft.step === "value"
  const field = draft.field!;
  const itemName = draft.itemName!;
  let updates: Partial<{ name: string; price: number; available: boolean }>;
  let confirmationDetail: string;

  if (field === "name") {
    if (!text.trim()) {
      return "What's the new name?";
    }
    updates = { name: text.trim() };
    confirmationDetail = `name changed to "${text.trim()}"`;
  } else if (field === "price") {
    const price = parsePriceInput(text);
    if (price === null) {
      return "Please reply with just the new price as a number, e.g. 1500.";
    }
    updates = { price };
    confirmationDetail = `price changed to $${price}`;
  } else {
    if (!isAffirmative(text) && !isNegative(text)) {
      return 'Please reply "yes" or "no".';
    }
    const available = isAffirmative(text);
    updates = { available };
    confirmationDetail = `now marked ${available ? "available" : "unavailable"}`;
  }

  try {
    await updateMenuItem(draft.itemId!, updates);
  } catch (error) {
    console.error("Failed to update menu item:", error);
    clearAdminDraft(session);
    session.state = "START";
    return saveFailedMessage("updating", "/edititem");
  }

  clearAdminDraft(session);
  session.state = "START";
  return `Updated "${itemName}" — ${confirmationDetail}.`;
}

async function continueRemoveItemFlow(session: Session, text: string): Promise<string> {
  const draft = getAdminDraft<RemoveItemDraft>(session);
  if (!draft) {
    session.state = "START";
    return draftLostMessage("/removeitem");
  }

  if (draft.step === "select") {
    const chosen = selectFromList(draft.items, text);
    if (!chosen) {
      return `Please reply with a number between 1 and ${draft.items.length}.`;
    }
    draft.itemId = chosen.id;
    draft.itemName = chosen.name;
    draft.step = "confirm";
    setAdminDraft(session, draft);
    return `Remove "${chosen.name}" from the menu? Reply "yes" to confirm, or "cancel" to stop.`;
  }

  // draft.step === "confirm"
  if (!isAffirmative(text)) {
    clearAdminDraft(session);
    session.state = "START";
    return "No changes made.";
  }

  const itemName = draft.itemName!;

  try {
    await deleteMenuItem(draft.itemId!);
  } catch (error) {
    console.error("Failed to delete menu item:", error);
    clearAdminDraft(session);
    session.state = "START";
    return saveFailedMessage("removing", "/removeitem");
  }

  clearAdminDraft(session);
  session.state = "START";
  return `Removed "${itemName}" from the menu.`;
}

// Entry point for continuing an in-progress admin menu flow. "cancel"
// works at any step, matching the same word customers use to abandon
// an order.
async function continueAdminMenuFlow(session: Session, text: string): Promise<string> {
  if (isCancelWord(text.trim().toLowerCase())) {
    clearAdminDraft(session);
    session.state = "START";
    return "Cancelled — no changes made.";
  }

  switch (session.state) {
    case "ADMIN_ADD_ITEM":
      return continueAddItemFlow(session, text);
    case "ADMIN_EDIT_ITEM":
      return continueEditItemFlow(session, text);
    case "ADMIN_REMOVE_ITEM":
      return continueRemoveItemFlow(session, text);
    default:
      // Unreachable — routeConversation only calls this when
      // isAdminMenuFlowState(session.state) is true — but keeps
      // TypeScript happy and fails safely if that ever changes.
      session.state = "START";
      return "Something went wrong — let's start over. Send /menu, /additem, /edititem, or /removeitem.";
  }
}

// Clears the order-specific fields on the session object. Caller is
// responsible for persisting the session afterwards.
function clearOrderFields(session: Session): void {
  session.customerName = undefined;
  session.deliveryArea = undefined;
  session.orderItems = undefined;
  session.quantity = undefined;
}

function buildConfirmationMessage(session: Session): string {
  return [
    "Please confirm your order:",
    `Name: ${session.customerName}`,
    `Area: ${session.deliveryArea}`,
    `Items: ${session.orderItems}`,
    `Quantity: ${session.quantity}`,
    'Reply "yes" to confirm, "no" to change the items, or "cancel" to start over.',
  ].join("\n");
}

type MissingField = "customerName" | "deliveryArea" | "orderItems" | "quantity";

function getMissingFields(session: Session): MissingField[] {
  const missing: MissingField[] = [];
  if (!session.customerName) missing.push("customerName");
  if (!session.deliveryArea) missing.push("deliveryArea");
  if (!session.orderItems) missing.push("orderItems");
  if (!session.quantity) missing.push("quantity");
  return missing;
}

function promptForField(field: MissingField): string {
  switch (field) {
    case "customerName":
      return "What's your name?";
    case "deliveryArea":
      return "What's your delivery area?";
    case "orderItems":
      return "What would you like to order?";
    case "quantity":
      return "How many would you like?";
  }
}

// Keeps the existing ConversationState column in sync with whichever
// field is currently missing — bookkeeping only, nothing reads this to
// decide behavior anymore.
function stateForField(field: MissingField): ConversationState {
  switch (field) {
    case "customerName":
      return "COLLECT_NAME";
    case "deliveryArea":
      return "COLLECT_AREA";
    case "orderItems":
      return "COLLECT_ITEMS";
    case "quantity":
      return "COLLECT_QUANTITY";
  }
}

// After any merge, decide what to say next: ask for the next missing
// field, or show the confirmation summary if nothing is missing.
function respondBasedOnMissingFields(session: Session): string {
  const missing = getMissingFields(session);
  if (missing.length > 0) {
    session.state = stateForField(missing[0]);
    return promptForField(missing[0]);
  }
  session.state = "CONFIRM_ORDER";
  return buildConfirmationMessage(session);
}

// Looks for a quantity number anywhere in an item string — "2 Jollof
// Rice", "Jollof Rice x2", "Chicken (2)" — rather than only at the very
// start, so more of the ways people actually phrase this are caught.
function extractItemQuantity(item: string): number | null {
  const match = item.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function itemHasQuantity(item: string): boolean {
  return extractItemQuantity(item) !== null;
}

function sumItemQuantities(items: string[]): number {
  return items.reduce((total, item) => total + (extractItemQuantity(item) ?? 0), 0);
}

// Merges whatever Gemini extracted into the session. Name and area
// always overwrite when present — this is what makes corrections
// ("my name is actually David") work naturally. Items are the one
// exception: if items are already known and this message isn't itself
// a correction, treat it as ADDING to the order ("also add a drink")
// rather than silently replacing it and losing what was already
// collected. Only an explicit correction ("actually make it fried
// rice instead") replaces the items outright.
function mergeExtractedInfo(session: Session, extracted: ExtractedOrderInfo): void {
  if (extracted.customerName) {
    session.customerName = extracted.customerName;
  }
  if (extracted.deliveryArea) {
    session.deliveryArea = extracted.deliveryArea;
  }
  if (extracted.items && extracted.items.length > 0) {
    const isAppending = Boolean(session.orderItems) && !extracted.correction;
    session.orderItems = isAppending
      ? `${session.orderItems}, ${extracted.items.join(", ")}`
      : extracted.items.join(", ");

    if (!extracted.quantity) {
      if (isAppending) {
        // Adding to an already-collected order — default an
        // unquantified new item ("also add a coke") to 1 rather than
        // leaving the running total stale and silently wrong.
        const addedTotal = extracted.items.reduce(
          (total, item) => total + (extractItemQuantity(item) ?? 1),
          0
        );
        const existing = session.quantity ? parseInt(session.quantity, 10) : 0;
        session.quantity = String((Number.isFinite(existing) ? existing : 0) + addedTotal);
      } else if (extracted.items.every(itemHasQuantity)) {
        // A fresh (or replaced) items list only auto-fills quantity
        // when every item explicitly states its own count — otherwise,
        // ask rather than assume a customer who hasn't mentioned
        // numbers at all means 1.
        session.quantity = String(sumItemQuantities(extracted.items));
      } else {
        // Replacing the item list without explicit counts invalidates
        // whatever quantity applied to the OLD items — clear it so the
        // customer gets asked again for the new list, instead of a
        // stale number that no longer clearly matches.
        session.quantity = undefined;
      }
    }
  }
  if (extracted.quantity && isValidQuantity(extracted.quantity)) {
    session.quantity = extracted.quantity;
  }
}

// Human-readable status for Gemini's context — more useful to it than
// the raw ConversationState enum name, since it directly says what's
// still needed instead of requiring Gemini to infer meaning from a
// label like "COLLECT_QUANTITY".
const MISSING_FIELD_LABELS: Record<MissingField, string> = {
  customerName: "name",
  deliveryArea: "delivery area",
  orderItems: "items",
  quantity: "quantity",
};

function describeState(session: Session): string {
  const missing = getMissingFields(session);
  if (missing.length === 0) {
    return "All order details are collected; the customer is deciding whether to confirm, change, or cancel.";
  }
  return `Still needs: ${missing.map((field) => MISSING_FIELD_LABELS[field]).join(", ")}.`;
}

// Menu context is a nice-to-have for pricing questions, not a
// requirement for Gemini to answer at all — if it fails to load,
// Gemini still replies, just without menu specifics.
async function getMenuContextSafe(): Promise<string | undefined> {
  try {
    return await getMenuText();
  } catch (error) {
    console.error("Failed to load menu context for Gemini:", error);
    return undefined;
  }
}

const ORDER_CANCELLED_MESSAGE = "No problem, I've cancelled that order. Whenever you're ready — what's your name?";

// Shared by both cancel paths (the deterministic "cancel" word, and
// Gemini detecting cancel intent) so the reset logic and message can't
// drift out of sync between them.
function cancelOrder(session: Session): string {
  clearOrderFields(session);
  session.state = "COLLECT_NAME";
  return ORDER_CANCELLED_MESSAGE;
}

async function finalizeOrder(session: Session): Promise<string> {
  const order = {
    chatId: session.chatId,
    customerName: session.customerName!,
    deliveryArea: session.deliveryArea!,
    items: session.orderItems!,
    quantity: session.quantity!,
  };

  // Save Order
  await saveOrder(order);

  // Notify Mira
  await notifyAdmin(order);

  // Clear session — back to a fresh state, ready for the next order.
  clearOrderFields(session);
  session.state = "START";

  return "Your order has been placed! Thank you for ordering from Mira's Kitchen.";
}

// Deterministic, Gemini-free responses for the handful of message
// shapes that never need language understanding. Returns null if none
// apply, meaning the message should go to Gemini instead.
async function tryDeterministicResponse(session: Session, text: string): Promise<string | null> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Nothing to understand — don't waste a Gemini call on empty input.
  if (!trimmed) {
    return "Sorry, I didn't catch that — could you send that again?";
  }

  if (isCancelWord(lower)) {
    return cancelOrder(session);
  }

  // A bare number almost always means quantity — but only once items are
  // known; before that, a stray number is ambiguous (could be part of an
  // address, a typo, anything) and is better left to Gemini to interpret
  // with full context rather than guessed at here.
  if (isBareNumber(trimmed) && session.orderItems) {
    if (!isValidQuantity(trimmed)) {
      return "Please enter a quantity of at least 1.";
    }
    session.quantity = trimmed;
    return respondBasedOnMissingFields(session);
  }

  const missing = getMissingFields(session);

  // Nothing left to collect — the customer is looking at (or reacting
  // to) the confirmation summary.
  if (missing.length === 0) {
    if (isAffirmative(lower)) {
      return finalizeOrder(session);
    }
    if (isNegative(lower)) {
      session.orderItems = undefined;
      session.quantity = undefined;
      session.state = "COLLECT_ITEMS";
      return "No problem — what would you like to order instead?";
    }
  }

  // Brand-new, completely empty session — skip a Gemini round-trip for
  // the single most common opening message. Trailing punctuation
  // ("Hi!", "Hello!!") shouldn't defeat this — it's still just a greeting.
  const lowerNoPunctuation = lower.replace(/[!?.]+$/, "");
  if (missing.length === 4 && SIMPLE_GREETINGS.has(lowerNoPunctuation)) {
    session.state = "COLLECT_NAME";
    return WELCOME_MESSAGE;
  }

  return null;
}

async function handleCustomerMessage(session: Session, text: string): Promise<string> {
  const deterministic = await tryDeterministicResponse(session, text);
  if (deterministic !== null) {
    return deterministic;
  }

  // Natural language: one Gemini call extracts structured slots and,
  // when relevant, drafts a reply to a question or small talk. Give it
  // everything it needs to answer accurately instead of guessing:
  // where the conversation stands, what's already known, the menu,
  // whether the kitchen is open, and recent context.
  const menuContext = await getMenuContextSafe();
  const context: ExtractionContext = {
    state: describeState(session),
    collected: {
      customerName: session.customerName,
      deliveryArea: session.deliveryArea,
      items: session.orderItems,
      quantity: session.quantity,
    },
    menuContext,
    // routeConversation already confirmed the kitchen is open before
    // handleCustomerMessage is ever reached — see the check right
    // before this function is called.
    isOpen: true,
    // Exclude the current message — it's already appended to
    // session.history by the webhook route before routeConversation
    // runs, and is passed separately below as userMessage.
    recentHistory: session.history.slice(0, -1),
  };
  const extracted = await extractOrderInfo(text, context);

  if (extracted.cancel) {
    const cancelled = cancelOrder(session);
    return extracted.reply ? `${extracted.reply}\n\n${cancelled}` : cancelled;
  }

  mergeExtractedInfo(session, extracted);

  if (extracted.reply) {
    // Answered a question / made small talk — continue from wherever
    // the customer left off afterwards, without losing track of what's
    // still actually missing.
    const missing = getMissingFields(session);
    let followUp: string;
    if (missing.length > 0) {
      session.state = stateForField(missing[0]);
      followUp = promptForField(missing[0]);
    } else {
      session.state = "CONFIRM_ORDER";
      followUp = buildConfirmationMessage(session);
    }
    return `${extracted.reply}\n\n${followUp}`;
  }

  if (extracted.confirmation && getMissingFields(session).length === 0) {
    return finalizeOrder(session);
  }

  return respondBasedOnMissingFields(session);
}

// Entry point for the webhook: mutates the session in place and returns
// the reply text to send back to the user. Caller is responsible for
// persisting the session with saveSession() afterwards.
export async function routeConversation(session: Session, text: string): Promise<string> {
  // /start always resets first, before anything else — admin check,
  // availability, everything. Also abandons any in-progress admin
  // menu-management flow.
  if (isStartCommand(text)) {
    clearOrderFields(session);
    clearAdminDraft(session);
    session.history = [];
    session.state = "COLLECT_NAME";
    return WELCOME_MESSAGE;
  }

  // An authorized admin mid-way through /additem, /edititem, or
  // /removeitem gets their plain replies ("Jollof Rice", "1500", "yes")
  // routed to that flow — checked before the generic admin-command
  // dispatch below, since these replies aren't slash commands
  // themselves.
  if (isAdminMenuFlowState(session.state) && isAuthorizedAdmin(session.chatId)) {
    return continueAdminMenuFlow(session, text);
  }

  if (isAdminCommand(text)) {
    return handleAdminCommand(session, text);
  }

  if (!(await isKitchenOpen())) {
    return "Sorry, the kitchen is currently closed. Please check back later.";
  }

  return handleCustomerMessage(session, text);
}
