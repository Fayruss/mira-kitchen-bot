# ForgePilot Mini Plan — Mira's Kitchen AI Telegram Bot

## Problem

Mira runs a small food business and needs a Telegram bot that can:
answer customer questions, take complete orders, notify her of new
orders, and let her open/close the kitchen and manage the menu —
without needing code changes for normal day-to-day business updates.

## Approach

Built incrementally, one testable feature at a time, in the order laid
out in `ARCHITECT.md`: webhook → sessions → conversation engine →
Gemini (standalone) → order collection → admin commands → notifications
→ reliability pass → production prep. Each phase was manually tested in
Telegram before moving to the next, per `CLAUDE.md`'s rule to never
continue past a failing feature.

## Architecture (at a glance)

```
Telegram → Webhook (Next.js API route) → Conversation Engine
  → Session Service (Supabase)
  → Availability Service (Supabase)
  → Order Service (Supabase + Telegram notification)
  → Menu Service (Supabase)
Gemini Service — standalone, not yet wired into the live flow
```

Business logic (state transitions, admin authorization, availability
checks) lives entirely in code. Gemini is scoped to language
understanding only and never touches workflow or storage, per
`CLAUDE.md`.

## What's implemented (MVP)

- Telegram webhook: receives updates, always acknowledges 200 (prevents
  Telegram retry storms on internal errors)
- Sessions: one row per chat in Supabase, survives restarts/redeploys
- Order-collection state machine: greeting → name → area → items →
  quantity → confirm → save → notify → clear, with blank-input
  re-prompting
- Admin commands: `/open`, `/close`, `/menu` — restricted to
  `ADMIN_CHAT_ID`, no dashboard
- Order notifications: formatted message to the admin on every
  confirmed order, with error handling so a Telegram hiccup never loses
  an already-saved order
- Gemini 2.5 Flash service: prompt template, JSON parsing, retries,
  safe fallback — built and independently testable via
  `npm run test:gemini`

## What's deliberately deferred

- **Gemini is not wired into the live conversation flow yet.** The
  order-collection state machine handles orders end-to-end without it.
  FAQ answering and free-form "what do you sell?" style questions
  aren't handled by the bot yet — every message during an active order
  is treated as an answer to whatever's currently being asked. Wiring
  Gemini in (so off-script messages get routed to FAQ/menu
  understanding instead of misread as order data) is the natural next
  increment.
- No admin dashboard — by design, per `CLAUDE.md`.
- No menu editing via Telegram — menu rows are managed directly in
  Supabase for now.

## Key tradeoffs and why

- **Simplicity over completeness**: shipped a working order pipeline
  first rather than a half-built AI layer touching everything.
- **In-code state machine over LLM-driven routing**: deterministic,
  testable, and free-tier friendly — no risk of Gemini
  hallucinating a state transition.
- **Single admin chat ID** for both command authorization and order
  notifications, rather than two separate roles — matches the actual
  one-admin use case without over-engineering.
