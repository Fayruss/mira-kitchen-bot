// menuActions.ts
// Responsibility: parse free-form admin text — natural language ("burger
// is now 4000", "remove burger") or a slash command with inline
// arguments ("/edititem Burger 4000") — into a structured MenuAction,
// with typo-tolerant fuzzy matching against the current menu.
//
// Deliberately pure: no Session, Telegram, or Supabase access, and no
// Gemini call. Menu mutations should never depend on an external AI
// call — this keeps admin menu edits fast, free, fully deterministic,
// and impossible to reach from the customer-facing NLU path (this
// module is only ever imported by the authenticated-admin branch of
// services/conversation.ts).

import { MenuItem } from "./menu";

export type MenuAction =
  | { type: "add"; name: string; price: number }
  | { type: "edit"; item: MenuItem; price: number }
  | { type: "remove"; item: MenuItem }
  | { type: "ambiguous"; question: string }
  | { type: "none" };

const ADD_KEYWORDS = new Set(["additem", "add", "new", "newitem", "create"]);
const REMOVE_KEYWORDS = new Set(["removeitem", "remove", "delete", "del"]);
const EDIT_KEYWORDS = new Set(["edititem", "edit", "change", "update", "make", "set"]);
const FILLER_WORDS = new Set([
  "item", "items", "price", "prices", "to", "is", "now", "the", "a", "an",
  "for", "at", "cost", "costs", "should", "be", "please",
]);

// --- Fuzzy matching -----------------------------------------------------

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[rows - 1][cols - 1];
}

// How many edits are tolerated before two names are considered "not a
// match" — scales with name length so short names still need a close
// match, but longer names tolerate a couple of typos (e.g. "burgr",
// "buger", "burgar" all within 1 edit of "burger").
function isCloseMatch(a: string, b: string): boolean {
  const distance = levenshteinDistance(a, b);
  const threshold = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.3));
  return distance <= threshold;
}

type MatchResult =
  | { kind: "one"; item: MenuItem }
  | { kind: "many"; items: MenuItem[] }
  | { kind: "none" };

function findMatchingItem(candidate: string, menuItems: MenuItem[]): MatchResult {
  const lowerCandidate = candidate.toLowerCase();

  // Exact match first (case-insensitive) — never ambiguous, even if
  // some other item name happens to be a close fuzzy neighbor too.
  const exact = menuItems.find((item) => item.name.toLowerCase() === lowerCandidate);
  if (exact) {
    return { kind: "one", item: exact };
  }

  const scored = menuItems
    .map((item) => ({ item, distance: levenshteinDistance(lowerCandidate, item.name.toLowerCase()) }))
    .filter(({ item }) => isCloseMatch(lowerCandidate, item.name.toLowerCase()))
    .sort((a, b) => a.distance - b.distance);

  if (scored.length === 0) {
    return { kind: "none" };
  }

  // Only ambiguous if the top two candidates are equally close — a
  // clearly-closest match wins outright even if others are "close enough".
  if (scored.length === 1 || scored[0].distance < scored[1].distance) {
    return { kind: "one", item: scored[0].item };
  }

  return { kind: "many", items: scored.slice(0, 3).map((s) => s.item) };
}

// --- Text parsing ---------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\/+/, " ")
    .replace(/[^a-z0-9\s.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTrailingPrice(text: string): { rest: string; price: number | null } {
  const match = text.match(/(\d+(?:\.\d+)?)\s*$/);
  if (!match || match.index === undefined) {
    return { rest: text, price: null };
  }
  const price = parseFloat(match[1]);
  const rest = text.slice(0, match.index).trim();
  return { rest, price: Number.isFinite(price) && price > 0 ? price : null };
}

type DetectedAction = "add" | "remove" | "edit" | null;

function detectActionAndStripKeywords(tokens: string[]): { action: DetectedAction; tokens: string[] } {
  let action: DetectedAction = null;
  const remaining: string[] = [];

  for (const token of tokens) {
    if (action === null && ADD_KEYWORDS.has(token)) {
      action = "add";
      continue;
    }
    if (action === null && REMOVE_KEYWORDS.has(token)) {
      action = "remove";
      continue;
    }
    if (action === null && EDIT_KEYWORDS.has(token)) {
      action = "edit";
      continue;
    }
    if (FILLER_WORDS.has(token)) {
      continue;
    }
    remaining.push(token);
  }

  return { action, tokens: remaining };
}

function toTitleCase(text: string): string {
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

// Cheap, no-Supabase-call check for "does this even look like an
// attempt to edit the menu?" — used to avoid a menu lookup (and a
// clarification question) for ordinary admin chat ("thanks", "ok").
export function looksLikeMenuActionAttempt(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) {
    return false;
  }
  if (/\d+(\.\d+)?\s*$/.test(normalized)) {
    return true;
  }
  const tokens = normalized.split(" ");
  return tokens.some((t) => ADD_KEYWORDS.has(t) || REMOVE_KEYWORDS.has(t) || EDIT_KEYWORDS.has(t));
}

// Parses admin free text into a MenuAction. Returns { type: "none" } for
// anything that doesn't look like a menu-editing attempt at all, so the
// caller can fall back to showing the dashboard instead of demanding
// clarification for ordinary conversation.
export function parseMenuActionText(text: string, menuItems: MenuItem[]): MenuAction {
  const normalized = normalize(text);
  if (!normalized) {
    return { type: "none" };
  }

  const { rest: beforePrice, price } = extractTrailingPrice(normalized);
  const tokens = beforePrice.split(" ").filter(Boolean);
  const { action, tokens: nameTokens } = detectActionAndStripKeywords(tokens);
  const candidateName = nameTokens.join(" ").trim();

  if (!candidateName && action === null) {
    return { type: "none" };
  }

  if (action === "remove") {
    if (!candidateName) {
      return { type: "ambiguous", question: "Which item would you like to remove?" };
    }
    const match = findMatchingItem(candidateName, menuItems);
    if (match.kind === "one") {
      return { type: "remove", item: match.item };
    }
    if (match.kind === "many") {
      const names = match.items.map((i) => `"${i.name}"`).join(" or ");
      return { type: "ambiguous", question: `Did you mean ${names}?` };
    }
    return {
      type: "ambiguous",
      question: `I don't see "${candidateName}" on the menu. Did you mean a different item?`,
    };
  }

  if (action === "add") {
    if (!candidateName) {
      return { type: "ambiguous", question: "What's the name of the new item?" };
    }
    if (price === null) {
      return { type: "ambiguous", question: `What's the price for "${candidateName}"?` };
    }
    return { type: "add", name: toTitleCase(candidateName), price };
  }

  // action === "edit", or no action keyword at all — a bare "item price"
  // ("burger 4000") defaults to an edit, matching how people naturally
  // state a price update.
  if (!candidateName || price === null) {
    if (action === "edit") {
      return {
        type: "ambiguous",
        question: candidateName
          ? `What should the new price for "${candidateName}" be?`
          : "Which item would you like to edit, and to what price?",
      };
    }
    return { type: "none" };
  }

  const match = findMatchingItem(candidateName, menuItems);
  if (match.kind === "one") {
    return { type: "edit", item: match.item, price };
  }
  if (match.kind === "many") {
    const names = match.items.map((i) => `"${i.name}"`).join(" or ");
    return { type: "ambiguous", question: `Did you mean ${names}?` };
  }

  // No existing item resembles this name — could be a typo'd existing
  // item, or a new item they forgot to flag as "add". Ask rather than
  // guess either way.
  return {
    type: "ambiguous",
    question: `I don't see "${candidateName}" on the menu. Did you want to add it as a new item, or did you mean an existing item?`,
  };
}
