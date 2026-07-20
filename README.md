# Mira's Kitchen AI Telegram Bot

AI-powered Telegram ordering assistant for a small food business, built for
the ForgePilot AI Developer Test.

See `CLAUDE.md` and `ARCHITECT.md` for project rules and architecture.

## Tech Stack

- Next.js 15 (App Router) + TypeScript
- TailwindCSS
- Supabase (database)
- Telegram Bot API
- Gemini 2.5 Flash (FAQ / natural language understanding only)
- Vercel (hosting)

## Folder Structure

```
/app
  /api/telegram     Telegram webhook route
  layout.tsx
  page.tsx
/services           gemini, orders, sessions, menu, availability, telegram
/lib                 supabase client, shared types
/utils               helper functions
/prompts             Gemini prompt files (e.g. faq.md)
```

## Setup

1. Install dependencies

   ```
   npm install
   ```

2. Copy the environment template and fill in real values

   ```
   cp .env.example .env.local
   ```

   | Variable | Description |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | Token from BotFather |
   | `ADMIN_IDS` | Preferred — comma-separated Telegram chat IDs for Admin Mode; each also receives new order notifications |
   | `ADMIN_CHAT_ID` | Legacy single-admin form, used only if `ADMIN_IDS` is unset |
   | `SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
   | `GEMINI_API_KEY` | Gemini API key |
   | `GEMINI_MODEL` | Optional — which Gemini model to use; falls back to a stable Flash model if unset |
   | `APP_BASE_URL` | Public URL of the deployed app (used to register the webhook) |

3. Set up the database

   Run `supabase/schema.sql` once in your Supabase project's SQL Editor.
   This creates `conversation_sessions`, `orders`, `availability`, and
   `menu_items`.

4. Run the dev server

   ```
   npm run dev
   ```

## Status

Telegram webhook, session management (Supabase-backed), an AI-assisted
slot-filling Conversation Engine (Gemini extracts order info + answers
questions in one call per message, state kept as bookkeeping), order
notifications to every admin on confirmation, and role-separated Admin
Mode are implemented. Features are built incrementally per the
development order in `ARCHITECT.md`.

### Customer experience

Plain conversation — AI-powered FAQ, slot-filling ordering (info in any
order, corrections anytime, questions answered without losing your
place), order confirmation, delivery questions. No commands to
remember.

### Admin Mode

Any message from a chat listed in `ADMIN_IDS` (or the legacy
`ADMIN_CHAT_ID`) always lands in Admin Mode — never the customer order
flow. A persistent button menu (Telegram's ReplyKeyboardMarkup) means
the owner almost never needs to type a command, though every button has
a matching slash command for anyone who prefers typing:

| Button | Command | What it does |
|---|---|---|
| 📋 Menu | `/menu` | Shows the current menu |
| ➕ Add Item | `/additem` | Guided flow: asks for name, price, then availability, and adds it |
| ✏ Edit Item | `/edititem` | Guided flow: pick an item by number, choose name/price/availability, give the new value |
| ❌ Remove Item | `/removeitem` | Guided flow: pick an item by number, confirm, and it's deleted |
| 🟢 Open Kitchen / 🔴 Close Kitchen | `/open` / `/close` | Toggles whether customers can order — only the relevant button shows, based on current status |
| 📦 Recent Orders | `/orders` | Lists the 10 most recent orders |
| ⚙ Settings | `/settings` | Shows kitchen status and configured admin IDs |

`/additem`, `/edititem`, and `/removeitem` are multi-step — the button
menu hides itself for the duration (so a stray tap can't be misread as
a text answer) and reappears once the flow ends. Reply "cancel" at any
point to stop without making changes. Anyone not in `ADMIN_IDS` gets
"not authorized" and cannot access any of this.

**Natural-language menu editing:** beyond the buttons/commands above,
an admin can just type plain English — "burger is now 4000", "remove
burger", "add fries 1500", even with typos ("burgr", "buger"). This is
fully deterministic (fuzzy name matching, no Gemini call — see
`services/menuActions.ts`), routes into the exact same functions the
guided flows use, and only ever runs for authenticated admins; a
customer sending identical text is handled as an ordinary order/FAQ
message and can never modify the menu. If the item or intent is
unclear, it asks one clarification question instead of guessing.
Deletions still require an explicit "yes" — natural language can never
skip that safety check.

## Deploying to production

See `DEPLOYMENT.md` for the full Vercel + Supabase + Telegram webhook
production setup, and `TESTING.md` for the manual testing checklist.
