// conversation.ts
// Responsibility: the Conversation Engine.
//
// Routes an incoming message to a reply. /start always resets first.
// Admin commands are handled next: /open, /close, /menu, /orders,
// /settings are single-shot; /additem, /edititem, /removeitem are
// guided, multi-step flows (see the "Admin menu management" section
// below). Beyond exact commands/buttons, an admin can also edit the
// menu with natural language ("burger is now 4000", "remove burger") —
// see the "Natural-language admin commands" section, which is fully
// deterministic (services/menuActions.ts — no Gemini, so this can never
// be reached from the customer-facing NLU path) and funnels into the
// exact same applyAddItem/applyItemEdit/applyRemoveItem functions the
// guided flows use, so there is one code path per mutation regardless
// of how it was triggered.
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
import { saveOrder, notifyAdmin, listRecentOrders, OrderRecord } from "./orders";
import { getMenuText, listMenuItems, addMenuItem, updateMenuItem, deleteMenuItem, MenuItem } from "./menu";
import { parseMenuActionText, looksLikeMenuActionAttempt } from "./menuActions";
import { getAdminChatIds } from "@/lib/env";
import { extractOrderInfo, ExtractedOrderInfo, ExtractionContext } from "./gemini";
import { sendMessageWithKeyboard, ReplyKeyboardMarkup, ReplyKeyboardRemove } from "./telegram";

const ADMIN_COMMANDS = ["/open", "/close", "/menu", "/additem", "/edititem", "/removeitem", "/orders", "/settings"];

export function isAdminCommand(text: string): boolean {
  return ADMIN_COMMANDS.includes(text.trim().toLowerCase());
}

function isAuthorizedAdmin(chatId: number): boolean {
  return getAdminChatIds().includes(chatId);
}

async function handleAdminCommand(session: Session, text: string): Promise<string> {
  if (!isAuthorizedAdmin(session.chatId)) {
    return "Sorry, you're not authorized to use admin commands.";
  }

  switch (text.trim().toLowerCase()) {
    case "/open":
      await openKitchen();
      return finishAdminAction(session, "Kitchen is now OPEN. Customers can place orders.");

    case "/close":
      await closeKitchen();
      return finishAdminAction(session, "Kitchen is now CLOSED. Customers cannot place new orders.");

    case "/menu": {
      const menuText = await getMenuText();
      return finishAdminAction(session, menuText);
    }

    case "/additem":
      return startAddItemFlow(session);

    case "/edititem":
      return startEditItemFlow(session);

    case "/removeitem":
      return startRemoveItemFlow(session);

    case "/orders": {
      const ordersText = await buildRecentOrdersText();
      return finishAdminAction(session, ordersText);
    }

    case "/settings": {
      const settingsText = await buildSettingsText();
      return finishAdminAction(session, settingsText);
    }

    default:
      return "Unknown admin command.";
  }
}

// ---------------------------------------------------------------------
// Admin Mode: role separation so the restaurant owner never goes
// through the customer order flow. Any message from an authorized admin
// (ADMIN_IDS, or the legacy ADMIN_CHAT_ID) is routed here instead of
// ever reaching handleCustomerMessage — see routeConversation. A
// persistent button menu (Telegram ReplyKeyboardMarkup) means Mira
// almost never needs to remember a command; typed slash commands still
// work too, for anyone who prefers that.
// ---------------------------------------------------------------------

const ADMIN_BUTTON_LABELS: Record<string, string> = {
  "📋 Menu": "/menu",
  "➕ Add Item": "/additem",
  "✏ Edit Item": "/edititem",
  "❌ Remove Item": "/removeitem",
  "🟢 Open Kitchen": "/open",
  "🔴 Close Kitchen": "/close",
  "📦 Recent Orders": "/orders",
  "⚙ Settings": "/settings",
};

// Bare, no-punctuation navigation words — case-insensitive. Separate
// from item-edit natural language (menuActions.ts): typing "menu" or
// "orders" has no sensible clarification fallback the way an ambiguous
// item edit does, so these are matched directly instead.
const ADMIN_BARE_WORD_COMMANDS: Record<string, string> = {
  menu: "/menu",
  orders: "/orders",
  "recent orders": "/orders",
  settings: "/settings",
  open: "/open",
  "open kitchen": "/open",
  close: "/close",
  "close kitchen": "/close",
};

// Maps a button tap, a typed slash command, or a bare navigation word
// to the canonical command handleAdminCommand understands. Returns
// null for anything else (a greeting, small talk, an unrecognized
// message) — routeConversation tries natural-language menu editing
// next, then shows the dashboard again if that doesn't match either.
function resolveAdminInput(text: string): string | null {
  const trimmed = text.trim();
  if (isAdminCommand(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (ADMIN_BUTTON_LABELS[trimmed]) {
    return ADMIN_BUTTON_LABELS[trimmed];
  }
  return ADMIN_BARE_WORD_COMMANDS[trimmed.toLowerCase()] ?? null;
}

function buildAdminKeyboard(isOpen: boolean): ReplyKeyboardMarkup {
  return {
    keyboard: [
      ["📋 Menu", "📦 Recent Orders"],
      ["➕ Add Item", "✏ Edit Item"],
      ["❌ Remove Item", isOpen ? "🔴 Close Kitchen" : "🟢 Open Kitchen"],
      ["⚙ Settings"],
    ],
    resize_keyboard: true,
  };
}

// Shows the Admin Mode dashboard: greeting, current kitchen status, and
// the button menu. Sent directly (not returned as a string) so the
// keyboard can be attached — callers return the "" this resolves to,
// which routeConversation/the webhook route treats as "already sent,
// nothing more to do".
async function sendAdminDashboard(session: Session): Promise<string> {
  const open = await isKitchenOpen();
  const text = ["Hi Mira 👋", `Kitchen: ${open ? "🟢 Open" : "🔴 Closed"}`, "Choose an option:"].join("\n");
  await sendMessageWithKeyboard(session.chatId, text, buildAdminKeyboard(open));
  return "";
}

// Sends the result of an admin action together with a freshly-built
// keyboard (so, e.g., the Open/Close Kitchen button immediately flips
// to match the new status) — one message instead of a separate
// confirmation + dashboard pair.
async function finishAdminAction(session: Session, message: string): Promise<string> {
  const open = await isKitchenOpen();
  await sendMessageWithKeyboard(session.chatId, message, buildAdminKeyboard(open));
  return "";
}

// Sends the first prompt of a guided text-entry flow (/additem,
// /edititem, /removeitem) and hides the button keyboard for its
// duration — otherwise a button tap mid-flow (e.g. "❌ Remove Item"
// tapped while answering "what's the new item's name?") would be read
// as literal text input for that step. The keyboard reappears via
// finishAdminAction once the flow ends (see the continue*Flow functions).
async function startAdminGuidedFlow(session: Session, prompt: string): Promise<string> {
  await sendMessageWithKeyboard(session.chatId, prompt, { remove_keyboard: true });
  return "";
}

async function buildRecentOrdersText(): Promise<string> {
  let orders: OrderRecord[];
  try {
    orders = await listRecentOrders(10);
  } catch (error) {
    console.error("Failed to load recent orders:", error);
    return "Sorry, I couldn't load recent orders right now. Please try again in a moment.";
  }

  if (orders.length === 0) {
    return "No orders yet.";
  }

  const lines = orders.map((order) => {
    const when = new Date(order.createdAt).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return `• ${order.customerName} (${order.deliveryArea}) — ${order.items}, qty ${order.quantity} — ${when}`;
  });

  return ["📦 Recent orders:", ...lines].join("\n");
}

async function buildSettingsText(): Promise<string> {
  const open = await isKitchenOpen();
  const adminIds = getAdminChatIds();
  return [
    "⚙ Settings",
    `Kitchen: ${open ? "🟢 Open" : "🔴 Closed"}`,
    `Admin chat ID(s): ${adminIds.length > 0 ? adminIds.join(", ") : "none configured"}`,
    "To update opening hours, delivery rules, or FAQ answers, set the RESTAURANT_FAQ environment variable — no code change needed.",
  ].join("\n");
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

async function startAddItemFlow(session: Session): Promise<string> {
  clearOrderFields(session);
  session.state = "ADMIN_ADD_ITEM";
  setAdminDraft(session, { step: "name" } satisfies AddItemDraft);
  return startAdminGuidedFlow(session, 'Let\'s add a new menu item. What\'s the name? (Reply "cancel" anytime to stop.)');
}

async function startEditItemFlow(session: Session): Promise<string> {
  const items = await listMenuItemsForAdmin();
  if (items === null) {
    return finishAdminAction(session, menuLoadFailedMessage("/edititem"));
  }
  if (items.length === 0) {
    return finishAdminAction(session, "The menu is empty right now — use /additem to add the first item.");
  }
  clearOrderFields(session);
  session.state = "ADMIN_EDIT_ITEM";
  setAdminDraft(session, { step: "select", items } satisfies EditItemDraft);
  return startAdminGuidedFlow(
    session,
    `Which item would you like to edit? Reply with the number.\n${formatSelectableList(items)}\n\n(Reply "cancel" anytime to stop.)`
  );
}

async function startRemoveItemFlow(session: Session): Promise<string> {
  const items = await listMenuItemsForAdmin();
  if (items === null) {
    return finishAdminAction(session, menuLoadFailedMessage("/removeitem"));
  }
  if (items.length === 0) {
    return finishAdminAction(session, "The menu is already empty — nothing to remove.");
  }
  clearOrderFields(session);
  session.state = "ADMIN_REMOVE_ITEM";
  setAdminDraft(session, { step: "select", items } satisfies RemoveItemDraft);
  return startAdminGuidedFlow(
    session,
    `Which item would you like to remove? Reply with the number.\n${formatSelectableList(items)}\n\n(Reply "cancel" anytime to stop.)`
  );
}

function selectFromList(items: MenuItem[], text: string): MenuItem | null {
  const index = parseInt(text.trim(), 10);
  if (!Number.isFinite(index) || index < 1 || index > items.length) {
    return null;
  }
  return items[index - 1];
}

// ---------------------------------------------------------------------
// Single source of truth for actually mutating the menu. Every trigger
// path — the guided /additem, /edititem, /removeitem flows AND the
// natural-language commands below — ends up calling exactly one of
// these three functions. There is no second place in the codebase that
// calls addMenuItem/updateMenuItem/deleteMenuItem.
// ---------------------------------------------------------------------

async function applyAddItem(session: Session, name: string, price: number, available: boolean): Promise<string> {
  try {
    await addMenuItem(name, price, available);
  } catch (error) {
    console.error("Failed to add menu item:", error);
    return finishAdminAction(session, saveFailedMessage("saving", "/additem"));
  }
  return finishAdminAction(session, `Added "${name}" — $${price}${available ? "" : " (unavailable)"}.`);
}

async function applyItemEdit(
  session: Session,
  itemId: string,
  itemName: string,
  field: EditableField,
  value: string | number | boolean
): Promise<string> {
  let updates: Partial<{ name: string; price: number; available: boolean }>;
  let confirmationDetail: string;

  if (field === "name") {
    updates = { name: value as string };
    confirmationDetail = `name changed to "${value}"`;
  } else if (field === "price") {
    updates = { price: value as number };
    confirmationDetail = `price changed to $${value}`;
  } else {
    const available = value as boolean;
    updates = { available };
    confirmationDetail = `now marked ${available ? "available" : "unavailable"}`;
  }

  try {
    await updateMenuItem(itemId, updates);
  } catch (error) {
    console.error("Failed to update menu item:", error);
    return finishAdminAction(session, saveFailedMessage("updating", "/edititem"));
  }

  return finishAdminAction(session, `Updated "${itemName}" — ${confirmationDetail}.`);
}

async function applyRemoveItem(session: Session, itemId: string, itemName: string): Promise<string> {
  try {
    await deleteMenuItem(itemId);
  } catch (error) {
    console.error("Failed to delete menu item:", error);
    return finishAdminAction(session, saveFailedMessage("removing", "/removeitem"));
  }
  return finishAdminAction(session, `Removed "${itemName}" from the menu.`);
}

async function continueAddItemFlow(session: Session, text: string): Promise<string> {
  const draft = getAdminDraft<AddItemDraft>(session);
  if (!draft) {
    session.state = "START";
    return finishAdminAction(session, draftLostMessage("/additem"));
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

  clearAdminDraft(session);
  session.state = "START";
  return applyAddItem(session, name!, price!, available);
}

async function continueEditItemFlow(session: Session, text: string): Promise<string> {
  const draft = getAdminDraft<EditItemDraft>(session);
  if (!draft) {
    session.state = "START";
    return finishAdminAction(session, draftLostMessage("/edititem"));
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
  const itemId = draft.itemId!;
  let value: string | number | boolean;

  if (field === "name") {
    if (!text.trim()) {
      return "What's the new name?";
    }
    value = text.trim();
  } else if (field === "price") {
    const price = parsePriceInput(text);
    if (price === null) {
      return "Please reply with just the new price as a number, e.g. 1500.";
    }
    value = price;
  } else {
    if (!isAffirmative(text) && !isNegative(text)) {
      return 'Please reply "yes" or "no".';
    }
    value = isAffirmative(text);
  }

  clearAdminDraft(session);
  session.state = "START";
  return applyItemEdit(session, itemId, itemName, field, value);
}

async function continueRemoveItemFlow(session: Session, text: string): Promise<string> {
  const draft = getAdminDraft<RemoveItemDraft>(session);
  if (!draft) {
    session.state = "START";
    return finishAdminAction(session, draftLostMessage("/removeitem"));
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
    return finishAdminAction(session, "No changes made.");
  }

  const itemId = draft.itemId!;
  const itemName = draft.itemName!;

  clearAdminDraft(session);
  session.state = "START";
  return applyRemoveItem(session, itemId, itemName);
}

// Entry point for continuing an in-progress admin menu flow. "cancel"
// works at any step, matching the same word customers use to abandon
// an order.
async function continueAdminMenuFlow(session: Session, text: string): Promise<string> {
  if (isCancelWord(text.trim().toLowerCase())) {
    clearAdminDraft(session);
    session.state = "START";
    return finishAdminAction(session, "Cancelled — no changes made.");
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
      return finishAdminAction(session, "Something went wrong — let's start over.");
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

// ---------------------------------------------------------------------
// Natural-language admin commands: "burger is now 4000", "remove
// burger", "add fries 1500", plus slash commands with inline args
// ("/edititem Burger 4000"). Fully deterministic (services/menuActions.ts
// — no Gemini), and only ever called from the authenticated-admin
// branch of routeConversation below, so a customer can never reach this
// even by sending the exact same text. Resolves into the same
// applyAddItem/applyItemEdit/applyRemoveItem functions the guided flows
// use — one code path per mutation regardless of trigger.
// ---------------------------------------------------------------------

// Returns null when the text doesn't look like a menu-editing attempt
// at all (routeConversation falls back to showing the dashboard), or
// the reply after handling it (an action taken, or one clarification
// question if the intent was ambiguous — never both a guess and a
// mutation).
async function tryHandleMenuActionText(session: Session, text: string): Promise<string | null> {
  if (!looksLikeMenuActionAttempt(text)) {
    return null;
  }

  const items = await listMenuItemsForAdmin();
  if (items === null) {
    // Supabase hiccup — fall back to the dashboard rather than a
    // confusing error for what might not even have been a menu-edit
    // attempt in the first place.
    return null;
  }

  const action = parseMenuActionText(text, items);

  switch (action.type) {
    case "none":
      return null;

    case "ambiguous":
      return finishAdminAction(session, action.question);

    case "add":
      return applyAddItem(session, action.name, action.price, true);

    case "edit":
      return applyItemEdit(session, action.item.id, action.item.name, "price", action.price);

    case "remove":
      // Route through the exact same confirmation step the guided
      // /removeitem flow uses, rather than deleting immediately —
      // deletions are the one destructive action here, so a
      // fuzzy-matched natural-language trigger still gets a safety
      // check before anything is removed.
      session.state = "ADMIN_REMOVE_ITEM";
      setAdminDraft(session, {
        step: "confirm",
        items: [action.item],
        itemId: action.item.id,
        itemName: action.item.name,
      } satisfies RemoveItemDraft);
      return startAdminGuidedFlow(
        session,
        `Remove "${action.item.name}" — $${action.item.price}? Reply "yes" to confirm, or "cancel" to stop.`
      );
  }
}

// Entry point for the webhook: mutates the session in place and returns
// the reply text to send back to the user (or "" if the reply was
// already sent directly, e.g. an Admin Mode message with a keyboard —
// see the webhook route, which skips its own send in that case).
// Caller is responsible for persisting the session with saveSession()
// afterwards.
export async function routeConversation(session: Session, text: string): Promise<string> {
  const isAdmin = isAuthorizedAdmin(session.chatId);

  // /start always resets first, before anything else. For an admin this
  // means straight into Admin Mode — never the customer greeting.
  if (isStartCommand(text)) {
    clearOrderFields(session);
    clearAdminDraft(session);
    session.history = [];
    if (isAdmin) {
      return sendAdminDashboard(session);
    }
    session.state = "COLLECT_NAME";
    return WELCOME_MESSAGE;
  }

  // An authorized admin mid-way through /additem, /edititem, or
  // /removeitem gets their plain replies ("Jollof Rice", "1500", "yes")
  // routed to that flow.
  if (isAdmin && isAdminMenuFlowState(session.state)) {
    return continueAdminMenuFlow(session, text);
  }

  // Role separation: an authorized admin NEVER enters the customer
  // order flow, regardless of what they type. Every message either
  // resolves to a recognized command/button (Menu, Add Item, Open
  // Kitchen, ...), a natural-language menu edit, or falls back to
  // showing the Admin Mode dashboard again — never "What's your name?"
  // / "Delivery area?" / "What would you like to order?".
  if (isAdmin) {
    const resolvedCommand = resolveAdminInput(text);
    if (resolvedCommand) {
      return handleAdminCommand(session, resolvedCommand);
    }

    const menuActionReply = await tryHandleMenuActionText(session, text);
    if (menuActionReply !== null) {
      return menuActionReply;
    }

    return sendAdminDashboard(session);
  }

  // Customer path — unchanged. tryHandleMenuActionText is never called
  // here, so a customer sending the exact same text ("burger 4000",
  // "remove burger") can never trigger a menu mutation — it's just
  // handled as an ordinary order-flow/FAQ message below.
  if (isAdminCommand(text)) {
    return handleAdminCommand(session, text);
  }

  if (!(await isKitchenOpen())) {
    return "Sorry, the kitchen is currently closed. Please check back later.";
  }

  return handleCustomerMessage(session, text);
}
