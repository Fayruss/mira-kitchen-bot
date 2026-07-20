# Gemini Prompts

This documents the prompt templates in `services/gemini.ts`. Kept here as
the human-readable reference so the wording can be reviewed/tuned
without reading the code.

## Slot extraction (`buildExtractionPrompt`) — used by the Conversation Engine

This is what `services/conversation.ts` actually calls for every
natural-language customer message. One call does double duty: it
extracts whichever order fields the message states, and (when relevant)
drafts a natural-language reply to a question — so the Conversation
Engine never needs a second Gemini round-trip per message.

Condensed in Phase 1 (reliability/performance pass) to roughly a third
of its original length — same context categories, same JSON schema,
tighter wording and no repeated phrasing.

```
Restaurant order-taking assistant. Extract JSON from the customer message below. Use ONLY the facts given here — if something isn't covered, say so honestly in reply instead of guessing.
Status: <e.g. "Still needs: delivery area, items, quantity.">
Known: <name=..., area=..., items=..., qty=... — whichever are already known, or "none">
Kitchen: <open|closed>
Menu:
<menu context from the Menu Service, or "unavailable">
FAQ/rules: <RESTAURANT_FAQ env var, or an honest "not configured yet" default>
Recent: <last few messages in this chat, when there's history>
Return ONLY this JSON: {"intent":"place_order|ask_menu|ask_price|ask_opening_hours|ask_delivery|ask_general|confirm_order|edit_order|cancel_order|greeting|unknown","customer_name":"","delivery_area":"","items":[],"quantity":"","question":"","correction":false,"confirmation":false,"cancel":false,"confidence":0,"reply":""}
Fill a field only if stated (never guess). items: as said, with quantity if given (word-numbers like "two" as digits); one entry per item. quantity: bare count answering "how many" for a single known item. correction=true only when replacing/removing something already known — then items must be the FULL updated list; adding something new instead is correction=false with only the new item(s). Change requested with no new value given: leave field empty, ask for it in reply. reply: brief answer to any question(s)/small talk, empty only for a plain order statement; list the full menu if asked what's available.
Message: "<the customer's raw message>"
```

### Contract

- Input: the customer's message, plus an `ExtractionContext` —
  conversation status, already-collected fields, menu+prices,
  kitchen open/closed, FAQ/business rules, and recent history.
- Output: strict JSON matching the shape above.
- Model: read from `GEMINI_MODEL`, falling back to a stable default if
  unset — never hardcoded as the only option.
- Exactly one Gemini request per call, no retries, wrapped in a
  6-second timeout — on any failure or timeout, falls back to a safe
  default result rather than retrying or hanging.
- Gemini never decides what happens next. `services/conversation.ts`:
  - decides *when* to call this at all (a handful of deterministic
    checks — `/start`, cancel words, bare numbers, yes/no at
    confirmation, plain greetings on a fresh session — are handled
    without any Gemini call)
  - assembles the context object (`describeState`, the session's
    current fields, `getMenuContextSafe()`, `session.history`)
  - merges whatever fields came back into the session (always
    overwriting, so corrections work naturally)
  - decides what to ask for next based on which fields are still
    missing
  - only shows the confirmation summary once nothing is missing
  - only saves the order once the customer explicitly confirms

### Restaurant FAQ / business rules

There's no `faq` or `business_rules` table in the current schema (schema
changes are out of scope). `RESTAURANT_FAQ` (an optional env var) lets an
operator supply real opening hours, delivery-area rules, and policies as
plain text, with zero code changes — same spirit as `menu_items` already
being editable without a deploy. If it's not set, Gemini is told plainly
that nothing has been configured, so it answers "I don't have that
information yet" instead of guessing.

## Q&A prompt (`buildPrompt`) — used by `understandMessage`

Still present, still exported, still exercised by `npm run
test:gemini`. Not currently called by the Conversation Engine (superseded
by the extraction prompt above, which handles both slot filling and
answering questions in one call) — kept as a standalone, independently
testable piece of the Gemini service.

```
You are a concise, friendly assistant for a small food business (a restaurant).
Classify the customer's message and write a brief, restaurant-specific reply.
Menu:
<menu context, if provided by the Menu Service>
<if a pendingQuestion is set: "The customer was already asked: "<pendingQuestion>" and
hasn't answered it yet. First answer their message, then end your reply by naturally
asking that same thing again so they can continue.">
Respond with ONLY strict JSON, no markdown formatting, in this exact shape:
{"intent": "faq" | "menu" | "order" | "other", "reply": "short reply text"}
intent meanings:
- faq: general questions about the business (hours, location, etc.)
- menu: asking what's available or about specific menu items
- order: trying to order, or mentioning food items/quantities
- other: anything that isn't one of the above
Keep the reply short (1-2 sentences) and conversational.
Customer message: "<the customer's raw message>"
```

