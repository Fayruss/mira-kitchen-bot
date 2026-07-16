# Loom Recording Checklist

Keep it tight — aim for 5–8 minutes. Screen-record Telegram + code side
by side where possible.

## Before hitting record

- [ ] Kitchen is set to OPEN (so the demo isn't blocked by a closed
      state you forgot about)
- [ ] `menu_items` has a few real rows in it
- [ ] Admin Telegram chat and a separate "customer" Telegram
      account/chat both open and ready
- [ ] Supabase dashboard open in a tab (to show rows appearing live)
- [ ] Code editor open to `ARCHITECT.md` and `services/conversation.ts`

## Intro (30–60s)

- [ ] State what the bot does and who it's for (Mira's Kitchen, one
      admin, customers order via Telegram)
- [ ] One sentence on the tech stack (Next.js on Vercel, Supabase,
      Telegram Bot API, Gemini 2.5 Flash)

## Live demo (3–4 min)

- [ ] As a customer: send a message, walk through the full order flow
      (name → area → items → quantity → confirm)
- [ ] Show the 🍽️ New Order notification arriving in the admin chat in
      real time
- [ ] Flip to Supabase, show the new row in `orders` and the session
      row reset to `START`
- [ ] As admin: run `/menu`, `/close`, then try to order as the
      customer (show it's blocked), then `/open` again
- [ ] From the customer account, try `/close` — show it's rejected as
      unauthorized

## Architecture walkthrough (2–3 min)

- [ ] Show `ARCHITECT.md` diagram, map it to the actual folders
      (`services/`, `app/api/telegram`)
- [ ] Open `services/conversation.ts` — point out the state machine and
      that Gemini is deliberately not in this path yet
- [ ] Briefly show `services/gemini.ts` and mention it's built and
      independently testable (`npm run test:gemini`) but not yet wired
      into the live flow — explain why (see `FORGEPILOT_PLAN.md`)
- [ ] Mention the webhook's error handling (always returns 200, logs
      failures) and why that matters for a Telegram integration

## Wrap-up (30s)

- [ ] Point to `README.md` / `DEPLOYMENT.md` / `TESTING.md` for anyone
      who wants to run or extend it
- [ ] State clearly what's deferred and why (not hidden, just scoped
      out for this MVP)

## After recording

- [ ] Watch it back once — trim dead air, confirm audio is audible
- [ ] Confirm the Loom link is set to "anyone with the link" (or
      whatever ForgePilot requires) before submitting
