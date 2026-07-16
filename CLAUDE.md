# CLAUDE.md

## Project

Mira's Kitchen AI Telegram Bot

This project is being built for the ForgePilot AI Developer Test.

Primary objective:

Ship a production-quality MVP that satisfies every ForgePilot requirement while keeping the implementation simple enough to finish in one day using Claude Free.

This project is also the first public portfolio project for AI AutoFlow.

---

## Success Criteria

The bot must:

- answer customer questions using AI
- collect complete food orders
- notify Mira on Telegram
- allow Mira to manage the menu herself
- allow Mira to open/close the kitchen
- require zero code changes for normal business updates

---

## Important Rules

Keep architecture simple.

Avoid unnecessary abstractions.

Avoid over-engineering.

Prefer readable code over clever code.

Every feature should be testable immediately after it is built.

Do not build future features until the current one is working.

---

## Technology Stack

Frontend:
None

Backend:
Next.js 15 API Routes

Database:
Supabase

AI:
Gemini 2.5 Flash Free

Bot:
Telegram Bot API

Hosting:
Vercel

---

## Database

Only create tables that are actually needed.

menu_items

availability

orders

conversation_sessions

No extra tables.

---

## AI Usage

Gemini should only perform:

- FAQ
- Menu understanding
- Natural conversation

Gemini should NOT:

- store memory
- manage sessions
- control workflow

Business logic stays in code.

---

## Sessions

Conversation state lives inside Supabase.

One row per Telegram chat.

Never keep state in memory.

---

## Admin Commands

/open

/close

/menu

No complicated admin dashboard.

---

## Coding Style

Small files.

Clear names.

One responsibility per function.

Minimal dependencies.

No unnecessary packages.

---

## Testing

Every completed feature must be tested in Telegram immediately.

Never continue after a failing feature.

Fix bugs first.

---

## Common Mistakes To Avoid

Do not overuse AI.

Do not create giant prompts.

Do not hardcode menu text.

Do not create duplicate session logic.

Do not build features that ForgePilot never requested.

Do not spend hours debugging automation tools.

Keep shipping.