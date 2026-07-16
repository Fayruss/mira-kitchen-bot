# Manual Testing Checklist

Run through this after any change that touches the webhook, sessions,
availability, or orders. Each item names what it's actually verifying.

## Basic order flow

- [ ] Send `hi` from a fresh chat → get the greeting, not an error
- [ ] Complete the full flow (name → area → items → quantity → `yes`)
      → get "Your order has been placed!"
- [ ] Order row appears in Supabase `orders` with the right fields
- [ ] `conversation_sessions` row for that chat is back to `state: START`
      with all order fields `null`
- [ ] Admin chat receives the 🍽️ New Order message within a couple seconds
- [ ] Send `hi` again right after → fresh greeting, no leftover data from
      the previous order

## Blank / malformed input (validation fix)

- [ ] At the name step, send a single space → bot re-asks for name,
      does **not** silently accept a blank name
- [ ] Same check at delivery area, items, and quantity steps
- [ ] At the confirmation step, send `yeah` / `yep` / `sure` → all treated
      as confirmation (not just exact `yes`)
- [ ] At the confirmation step, send something unrelated (e.g. `wait no`)
      → routes back to "what would you like to order?" instead of
      silently placing the order

## Admin commands

- [ ] From the admin chat: `/menu` lists current `menu_items` rows
- [ ] From the admin chat: `/close` → availability flips to `false` in
      Supabase, reply confirms
- [ ] From a non-admin chat while closed: any message → "kitchen is
      currently closed", order flow does not proceed
- [ ] From the admin chat: `/open` → availability flips back to `true`
- [ ] From a **non-admin** chat: `/open`, `/close`, `/menu` all get
      "not authorized" and do **not** change availability or return the
      menu

## Admin menu management (/additem, /edititem, /removeitem)

- [ ] `/additem` → answer name, price, then "yes"/"no" for availability
      → new row appears in `menu_items` with the right values
- [ ] `/additem` with a non-numeric price (e.g. "free") → re-prompted
      for a number instead of a bad row being saved
- [ ] `/edititem` → shows a numbered list of current items → pick a
      number → choose "price" → give a new number → `menu_items` row
      updates, other fields untouched
- [ ] `/edititem` → choose "availability" → reply "no" → item's
      `available` flips to `false`
- [ ] `/removeitem` → pick a number → confirm with "yes" → row is gone
      from `menu_items`
- [ ] `/removeitem` → pick a number → reply anything other than "yes"
      at the confirm step → item is **not** deleted
- [ ] Mid-flow (any of the three), reply "cancel" → flow stops, no
      change is made, admin is back to normal
- [ ] Send `/edititem` or `/removeitem` when the menu is empty → clear
      message, no crash, no numbered list of nothing
- [ ] From a **non-admin** chat: `/additem`, `/edititem`, `/removeitem`
      all get "not authorized" and cannot start a flow
- [ ] While mid-flow, send `/start` → flow is abandoned, session resets
      normally (no leftover draft interferes with the next conversation)

## Error handling / webhook reliability (this round's main fix)

- [ ] Send a malformed request body directly to `/api/telegram` (not
      valid Telegram update JSON) → route still responds `200 {"ok":true}`,
      no 500, check server logs show the error was caught
- [ ] Temporarily break `SUPABASE_URL` (wrong value) and message the bot
      → webhook still returns 200 (check Vercel/function logs, not the
      chat — the customer won't get a reply, but Telegram won't get a
      failure status and won't retry-storm the same update)
- [ ] Restore `SUPABASE_URL` and confirm normal flow resumes

## Session persistence / concurrency

- [ ] Message the bot, then immediately restart the dev server /
      redeploy, then message again → conversation continues from where
      it left off (state survived in Supabase, not reset)
- [ ] Two different Telegram accounts messaging at the same time stay on
      independent sessions/states (no cross-talk)
- [ ] (Best-effort, hard to trigger manually) Rapidly double-tap send on
      the very first message from a brand-new chat — should not produce
      a duplicate-key error; both taps should resolve to the same single
      session

## Config sanity

- [ ] `.env.local` uses `SUPABASE_URL` (not the old
      `NEXT_PUBLIC_SUPABASE_URL`) — if you have an older `.env.local`,
      rename the key or the app will fail to start Supabase calls
- [ ] `ADMIN_CHAT_ID` set to a real numeric chat id — confirm setting it
      to an empty string is treated as "not configured" (admin commands
      and notifications should behave as if unset, not silently use
      chat id `0`)

## Known limitations (not fixed this round — flagged, not silent)

- If the exact same customer message is somehow delivered twice by
  Telegram *and* the first delivery got far enough to save the order
  but failed before saving the cleared session state, a second delivery
  of that same "yes" could save a duplicate order. This is a narrow
  window (between `saveOrder`/`notifyAdmin` succeeding and `saveSession`
  persisting the cleared state) and returning 200 immediately reduces
  how often Telegram would even attempt a retry, but it isn't fully
  eliminated. Worth revisiting if duplicate orders are ever observed in
  practice — likely fix would be an idempotency key on the order or a
  DB-level transaction.
