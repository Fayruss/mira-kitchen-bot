// gemini.ts
// Responsibility: turn a customer's natural-language message into a short,
// structured interpretation — FAQ answers, menu understanding, and basic
// intent detection.
//
// Gemini NEVER stores state, manages sessions, or makes business
// decisions. It only returns JSON. The Conversation Engine (business
// logic, in code) decides what to actually do with that JSON.
//
// The prompt template used below is documented in prompts/faq.md.

import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL_NAME = "gemini-3-flash-preview";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

export type GeminiIntent = "faq" | "menu" | "order" | "other";

export type GeminiResult = {
  intent: GeminiIntent;
  reply: string;
};

const VALID_INTENTS: GeminiIntent[] = ["faq", "menu", "order", "other"];

// Returned whenever Gemini can't be reached or gives back something we
// can't parse, so the bot always has something safe to say.
const FALLBACK_RESULT: GeminiResult = {
  intent: "other",
  reply: "Sorry, I didn't quite catch that. Could you rephrase?",
};

// Short prompt, on purpose — Gemini's job here is language understanding
// only, not workflow. menuContext is optional plain text passed in by the
// Menu Service so Gemini can answer "what's available"/pricing questions.
// pendingQuestion (optional) is whatever the Conversation Engine is still
// waiting to hear (e.g. "How many would you like?") — when set, Gemini
// answers the customer's message first, then re-asks it so the order
// flow can continue naturally instead of stalling.
function buildPrompt(userMessage: string, menuContext?: string, pendingQuestion?: string): string {
  return [
    "You are a concise, friendly assistant for a small food business (a restaurant).",
    "Classify the customer's message and write a brief, restaurant-specific reply.",
    menuContext ? `Menu:\n${menuContext}` : "",
    pendingQuestion
      ? `The customer was already asked: "${pendingQuestion}" and hasn't answered it yet. First answer their message, then end your reply by naturally asking that same thing again so they can continue.`
      : "",
    "Respond with ONLY strict JSON, no markdown formatting, in this exact shape:",
    '{"intent": "faq" | "menu" | "order" | "other", "reply": "short reply text"}',
    "intent meanings:",
    "- faq: general questions about the business (hours, location, etc.)",
    "- menu: asking what's available or about specific menu items",
    "- order: trying to order, or mentioning food items/quantities",
    "- other: anything that isn't one of the above",
    "Keep the reply short (1-2 sentences) and conversational.",
    `Customer message: "${userMessage}"`,
  ]
    .filter(Boolean)
    .join("\n");
}

function getClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  return new GoogleGenerativeAI(apiKey);
}

// Strips markdown code fences if Gemini adds them despite being asked
// not to, then parses and validates the JSON shape.
function parseGeminiResponse(rawText: string): GeminiResult {
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !VALID_INTENTS.includes(parsed.intent) ||
    typeof parsed.reply !== "string"
  ) {
    throw new Error("Gemini response did not match the expected JSON shape");
  }

  return { intent: parsed.intent, reply: parsed.reply };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sends a customer message to Gemini and returns a structured
// interpretation. Retries on transient failures or malformed JSON.
// Never throws — falls back to a safe default reply if every attempt
// fails, so a Gemini outage never breaks the bot.
export async function understandMessage(
  userMessage: string,
  menuContext?: string,
  pendingQuestion?: string
): Promise<GeminiResult> {
  let client: GoogleGenerativeAI;
  try {
    client = getClient();
  } catch (error) {
    console.error("Gemini is not configured:", error);
    return FALLBACK_RESULT;
  }

  const model = client.getGenerativeModel({ model: MODEL_NAME });
  const prompt = buildPrompt(userMessage, menuContext, pendingQuestion);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      return parseGeminiResponse(text);
    } catch (error) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      console.error(`Gemini attempt ${attempt} failed:`, error);
      if (isLastAttempt) {
        return FALLBACK_RESULT;
      }
      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  // Unreachable — the loop above always returns — but keeps TypeScript happy.
  return FALLBACK_RESULT;
}

// ---------------------------------------------------------------------
// Slot extraction — one call that both extracts structured order info
// AND (when relevant) drafts a natural-language reply, so the
// Conversation Engine never needs two Gemini round-trips for a single
// customer message. Additive to the module — understandMessage above
// is unchanged and still used by npm run test:gemini.
// ---------------------------------------------------------------------

export type OrderIntent =
  | "place_order"
  | "ask_menu"
  | "ask_price"
  | "ask_opening_hours"
  | "ask_delivery"
  | "ask_general"
  | "confirm_order"
  | "edit_order"
  | "cancel_order"
  | "greeting"
  | "unknown";

const ORDER_INTENTS: OrderIntent[] = [
  "place_order", "ask_menu", "ask_price", "ask_opening_hours", "ask_delivery",
  "ask_general", "confirm_order", "edit_order", "cancel_order", "greeting", "unknown",
];

export type ExtractedOrderInfo = {
  intent: OrderIntent;
  customerName?: string;
  deliveryArea?: string;
  items?: string[];
  quantity?: string;
  question?: string;
  correction: boolean;
  confirmation: boolean;
  cancel: boolean;
  confidence: number;
  // Not part of the original slot schema — a natural-language answer has
  // to come from somewhere, and generating it in the same call (instead
  // of a second Gemini round-trip) is what keeps this to one API call
  // per message. Only set when there's something to say back to the
  // customer (a question was asked, or small talk).
  reply?: string;
};

const FALLBACK_EXTRACTION: ExtractedOrderInfo = {
  intent: "unknown",
  correction: false,
  confirmation: false,
  cancel: false,
  confidence: 0,
  reply: "Sorry, I didn't quite catch that — could you rephrase?",
};

export type ExtractionContext = {
  // Short, human-readable description of where the conversation stands
  // (e.g. "Still needs: delivery area, items, quantity."). Lets Gemini
  // avoid asking for things already covered and stay coherent about
  // what's left.
  state?: string;
  // Whatever the session has already collected, so Gemini never asks
  // the customer to repeat themselves or misreads a message as
  // providing something that's already known.
  collected?: {
    customerName?: string;
    deliveryArea?: string;
    items?: string;
    quantity?: string;
  };
  // Plain-text menu with prices, from the Menu Service.
  menuContext?: string;
  // Whether the kitchen is currently open.
  isOpen?: boolean;
  // The last few messages in this conversation, oldest first, excluding
  // the current one (that's passed separately as userMessage).
  recentHistory?: string[];
};

// No `faq`/`business_rules` table exists in the current schema, and
// schema changes are out of scope here — so there's no real database
// source for opening hours, delivery-area rules, or policies yet.
// Rather than inventing plausible-sounding facts (which Gemini would
// then confidently repeat as true), RESTAURANT_FAQ lets an operator
// supply real text via one env var — zero code changes, same spirit as
// menu_items already being editable without a deploy. If it's not set,
// Gemini is told plainly that nothing has been configured, so it
// truthfully says "I don't know" instead of guessing.
function getRestaurantInfo(): string {
  const configured = process.env.RESTAURANT_FAQ;
  if (configured && configured.trim()) {
    return configured.trim();
  }
  return "No specific opening hours, delivery-area list, or business policies have been configured yet.";
}

// Only extracts a field when the customer actually stated it — Gemini
// is explicitly told never to guess, and parsing below drops empty
// strings back to undefined so a merge step downstream can't
// accidentally overwrite known data with blanks.
function buildExtractionPrompt(userMessage: string, context: ExtractionContext = {}): string {
  const { state, collected, menuContext, isOpen, recentHistory } = context;

  const collectedLines = [
    collected?.customerName ? `- Name: ${collected.customerName}` : null,
    collected?.deliveryArea ? `- Delivery area: ${collected.deliveryArea}` : null,
    collected?.items ? `- Items: ${collected.items}` : null,
    collected?.quantity ? `- Quantity: ${collected.quantity}` : null,
  ].filter(Boolean);

  return [
    "You are an order-taking assistant for a small restaurant on Telegram.",
    "Read the customer's message and extract structured information as JSON.",
    "",
    "=== CONTEXT (use only these facts — never invent beyond them) ===",
    state ? `Conversation status: ${state}` : null,
    collectedLines.length > 0
      ? `Already collected from this customer — do not ask for these again unless they want to change them:\n${collectedLines.join("\n")}`
      : "Nothing has been collected from this customer yet.",
    typeof isOpen === "boolean" ? `Kitchen status right now: ${isOpen ? "OPEN" : "CLOSED"}.` : null,
    menuContext ? `Menu, with prices:\n${menuContext}` : "Menu: not available right now — don't guess prices or items.",
    `Restaurant FAQ and business rules:\n${getRestaurantInfo()}`,
    recentHistory && recentHistory.length > 0
      ? `Recent conversation, oldest first:\n${recentHistory.map((m) => `- ${m}`).join("\n")}`
      : null,
    "=== END CONTEXT ===",
    "",
    "Respond with ONLY strict JSON, no markdown, in exactly this shape:",
    '{"intent": "place_order" | "ask_menu" | "ask_price" | "ask_opening_hours" | "ask_delivery" | "ask_general" | "confirm_order" | "edit_order" | "cancel_order" | "greeting" | "unknown", "customer_name": "", "delivery_area": "", "items": [], "quantity": "", "question": "", "correction": false, "confirmation": false, "cancel": false, "confidence": 0, "reply": ""}',
    "Rules:",
    "- Only fill customer_name, delivery_area, items, or quantity if the message actually states them. Never guess — leave empty otherwise.",
    '- items: menu items the customer mentioned, as they said them, including a quantity if given, in any phrasing (e.g. "2 Jollof Rice", "Jollof Rice x2", "two jollof rice" — convert word numbers like "two" to digits). Use one array entry per distinct item.',
    "- quantity: only a bare count (e.g. \"3\") when the customer is answering how many of a single, already-named item — separate from items.",
    '- correction: true ONLY if the customer is replacing/changing/removing an item or value they already gave (e.g. "actually make it fried rice instead", "remove the chicken", "change my area to Lekki"). When correction is true and items are involved, "items" must be the COMPLETE updated list of everything the customer wants going forward (combine the "Already collected" items with the change, e.g. keep the ones not mentioned) — never just the one item that changed, since this replaces the whole list. If they are ADDING something new on top of what\'s already collected instead (e.g. "also add a drink", "can I get a coke too"), set correction to false and list only the new item(s) — do not repeat items already collected, those are kept automatically.',
    "- If the customer says they want to change something but doesn't give the new value (e.g. \"I want to change my delivery area\" with no area named), leave that field empty and set reply to ask for the new value — don't silently do nothing.",
    "- confirmation: true if the customer is confirming/agreeing to place the order as summarized so far.",
    "- cancel: true if the customer wants to cancel or abandon the order.",
    "- question: the customer's question in their own words, if they asked one. If they asked more than one question, combine them here.",
    "- reply: a short (1-2 sentences, longer only if genuinely needed — e.g. to cover multiple questions, or to list the full menu when asked what's available), friendly, restaurant-specific answer if the customer asked a question (answer ALL questions asked, even if there are several in one message), made small talk, or just greeted you. Leave empty only for a plain order/info statement with nothing to respond to.",
    "- confidence: 0 to 1, how confident you are in this extraction.",
    "- CRITICAL: base every answer only on the CONTEXT above (menu, prices, kitchen status, FAQ/business rules, what's already collected). If the customer asks something this context doesn't cover — a price not on the menu, hours, a policy, anything — your reply must honestly say you don't have that information, and suggest they ask the restaurant directly if appropriate. Never invent or assume an answer.",
    `Customer message: "${userMessage}"`,
  ]
    .filter(Boolean)
    .join("\n");
}

function toTrimmedStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseExtractionResponse(rawText: string): ExtractedOrderInfo {
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Gemini extraction response was not an object");
  }

  const intent: OrderIntent = ORDER_INTENTS.includes(parsed.intent) ? parsed.intent : "unknown";

  const items = Array.isArray(parsed.items)
    ? parsed.items
        .filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item: string) => item.trim())
    : undefined;

  return {
    intent,
    customerName: toTrimmedStringOrUndefined(parsed.customer_name),
    deliveryArea: toTrimmedStringOrUndefined(parsed.delivery_area),
    items: items && items.length > 0 ? items : undefined,
    quantity: toTrimmedStringOrUndefined(parsed.quantity),
    question: toTrimmedStringOrUndefined(parsed.question),
    correction: Boolean(parsed.correction),
    confirmation: Boolean(parsed.confirmation),
    cancel: Boolean(parsed.cancel),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    reply: toTrimmedStringOrUndefined(parsed.reply),
  };
}

// Extracts structured slot data (+ an optional natural-language reply)
// from a single customer message. Retries on transient failures or
// malformed JSON, same as understandMessage. Never throws — falls back
// to a safe "please rephrase" result so a Gemini outage never breaks
// the conversation.
export async function extractOrderInfo(
  userMessage: string,
  context?: ExtractionContext
): Promise<ExtractedOrderInfo> {
  let client: GoogleGenerativeAI;
  try {
    client = getClient();
  } catch (error) {
    console.error("Gemini is not configured:", error);
    return FALLBACK_EXTRACTION;
  }

  const model = client.getGenerativeModel({ model: MODEL_NAME });
  const prompt = buildExtractionPrompt(userMessage, context);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      return parseExtractionResponse(text);
    } catch (error) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      console.error(`Gemini extraction attempt ${attempt} failed:`, error);
      if (isLastAttempt) {
        return FALLBACK_EXTRACTION;
      }
      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  // Unreachable — the loop above always returns — but keeps TypeScript happy.
  return FALLBACK_EXTRACTION;
}
