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
//
// Reliability/performance notes (Phase 1):
// - Model is read from GEMINI_MODEL at call time — never hardcoded as
//   the only option. If unset, falls back to DEFAULT_MODEL, a
//   currently-supported stable Flash model. Rotating to a newer model
//   is then just an env var change, no redeploy risk from a
//   since-deprecated hardcoded name.
// - No retry loop: exactly one Gemini request per call. A Vercel
//   serverless function has a hard wall-clock limit; retrying a slow
//   provider only multiplies the chance of hitting it (504) instead of
//   reducing it.
// - Every request is wrapped in an 8-second timeout (withTimeout, using
//   AbortController) so a hung/slow Gemini call can never itself cause
//   the function invocation to time out — it fails fast into the
//   existing fallback response instead.

import { GoogleGenerativeAI } from "@google/generative-ai";

// Currently-supported, stable Gemini Flash model — used only if
// GEMINI_MODEL isn't set in the environment. Never hardcode a specific
// model as the only option: set GEMINI_MODEL to change models without a
// code change, and to avoid ever being stuck on a since-deprecated name.
const DEFAULT_MODEL = "gemini-3.1-flash-lite";

function getModelName(): string {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

// 6s, not 10s: this function's caller has a hard ~10s wall-clock budget
// (see maxDuration in app/api/telegram/route.ts), and a single request
// also does session load/save and a Telegram send around this call.
// Leaving only "8s timeout + a few hundred ms of overhead" cut it too
// close to 10s in practice — 6s leaves real margin for the rest of the
// request instead of the timeout itself risking a 504.
const REQUEST_TIMEOUT_MS = 6000;

// Guarantees a Gemini call resolves or fails within REQUEST_TIMEOUT_MS,
// independent of whether the request itself ever settles — this is
// what keeps a slow Gemini response from ever causing a Vercel function
// invocation timeout. controller.abort() is also called so the request
// is told to stop, on top of the caller receiving a timely rejection
// either way.
function withTimeout<T>(promise: Promise<T>, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Gemini request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export type GeminiIntent = "faq" | "menu" | "order" | "other";

export type GeminiResult = {
  intent: GeminiIntent;
  reply: string;
};

const VALID_INTENTS: GeminiIntent[] = ["faq", "menu", "order", "other"];

// Returned whenever Gemini can't be reached, times out, or gives back
// something we can't parse, so the bot always has something safe to say.
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

// Sends a customer message to Gemini and returns a structured
// interpretation. Exactly one request — no retries. Never throws —
// falls back to a safe default reply on any failure or timeout, so a
// Gemini outage or slow response never breaks the bot or the function's
// time budget.
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

  const model = client.getGenerativeModel({ model: getModelName() });
  const prompt = buildPrompt(userMessage, menuContext, pendingQuestion);
  const controller = new AbortController();

  try {
    const result = await withTimeout(model.generateContent(prompt), controller);
    const text = result.response.text();
    return parseGeminiResponse(text);
  } catch (error) {
    console.error("Gemini request failed:", error);
    return FALLBACK_RESULT;
  }
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

// Condensed on purpose (Phase 1: prompt was cut by roughly two-thirds
// by tightening wording and removing repeated phrasing, while keeping
// every context category and the exact same JSON schema/field
// semantics as before — see prompts/faq.md for the full rationale).
function buildExtractionPrompt(userMessage: string, context: ExtractionContext = {}): string {
  const { state, collected, menuContext, isOpen, recentHistory } = context;

  const known =
    [
      collected?.customerName && `name=${collected.customerName}`,
      collected?.deliveryArea && `area=${collected.deliveryArea}`,
      collected?.items && `items=${collected.items}`,
      collected?.quantity && `qty=${collected.quantity}`,
    ]
      .filter(Boolean)
      .join(", ") || "none";

  return [
    "Restaurant order-taking assistant. Extract JSON from the customer message below. Use ONLY the facts given here — if something isn't covered, say so honestly in reply instead of guessing.",
    state ? `Status: ${state}` : null,
    `Known: ${known}`,
    typeof isOpen === "boolean" ? `Kitchen: ${isOpen ? "open" : "closed"}` : null,
    menuContext ? `Menu:\n${menuContext}` : "Menu: unavailable",
    `FAQ/rules: ${getRestaurantInfo()}`,
    recentHistory && recentHistory.length > 0 ? `Recent: ${recentHistory.join(" | ")}` : null,
    'Return ONLY this JSON: {"intent":"place_order|ask_menu|ask_price|ask_opening_hours|ask_delivery|ask_general|confirm_order|edit_order|cancel_order|greeting|unknown","customer_name":"","delivery_area":"","items":[],"quantity":"","question":"","correction":false,"confirmation":false,"cancel":false,"confidence":0,"reply":""}',
    'Fill a field only if stated (never guess). items: as said, with quantity if given (word-numbers like "two" as digits); one entry per item. quantity: bare count answering "how many" for a single known item. correction=true only when replacing/removing something already known — then items must be the FULL updated list; adding something new instead is correction=false with only the new item(s). Change requested with no new value given: leave field empty, ask for it in reply. reply: brief answer to any question(s)/small talk, empty only for a plain order statement; list the full menu if asked what\'s available.',
    `Message: "${userMessage}"`,
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
// from a single customer message. Exactly one Gemini request — no
// retries. Never throws — falls back to a safe "please rephrase" result
// on any failure or timeout, so a Gemini outage or slow response never
// breaks the conversation or risks a Vercel function timeout.
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

  const model = client.getGenerativeModel({ model: getModelName() });
  const prompt = buildExtractionPrompt(userMessage, context);
  const controller = new AbortController();

  try {
    const result = await withTimeout(model.generateContent(prompt), controller);
    const text = result.response.text();
    return parseExtractionResponse(text);
  } catch (error) {
    console.error("Gemini extraction failed:", error);
    return FALLBACK_EXTRACTION;
  }
}
