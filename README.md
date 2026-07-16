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
   | `ADMIN_CHAT_ID` | Telegram chat ID authorized to run admin commands — also receives new order notifications |
   | `SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
   | `GEMINI_API_KEY` | Gemini API key |
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
notifications to the admin on confirmation, and admin commands are
implemented. Features are built incrementally per the development order
in `ARCHITECT.md`.

### Admin commands

Restricted to `ADMIN_CHAT_ID`. All are conversational — no SQL,
Supabase, or code editing required.

| Command | What it does |
|---|---|
| `/open` | Marks the kitchen open — customers can order |
| `/close` | Marks the kitchen closed — customers can't place new orders |
| `/menu` | Shows the current menu |
| `/additem` | Guided flow: asks for name, price, then availability, and adds it |
| `/edititem` | Guided flow: pick an item by number, choose name/price/availability, give the new value |
| `/removeitem` | Guided flow: pick an item by number, confirm, and it's deleted |

`/additem`, `/edititem`, and `/removeitem` are multi-step — reply
"cancel" at any point to stop without making changes.

## Deploying to production

See `DEPLOYMENT.md` for the full Vercel + Supabase + Telegram webhook
production setup, and `TESTING.md` for the manual testing checklist.
