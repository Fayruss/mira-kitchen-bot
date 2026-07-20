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

## Admin Mode (role separation)

- [ ] Message the bot from an admin chat (any text — "hi", random words,
      anything not a recognized command/button) → Admin Mode dashboard
      appears ("Hi Mira 👋", kitchen status, button menu) — **never**
      "What's your name?"
- [ ] From the admin chat, send `/start` → straight into Admin Mode, not
      the customer greeting
- [ ] Tap 🟢 Open Kitchen / 🔴 Close Kitchen → status flips, and the
      keyboard's button immediately updates to show the opposite action
- [ ] Tap 📋 Menu, 📦 Recent Orders, ⚙ Settings → each shows its info
      and the keyboard reappears afterward
- [ ] Tap ➕ Add Item → keyboard disappears (hidden for the guided
      text-entry flow), complete the flow → keyboard reappears with the
      confirmation message
- [ ] Mid-`/additem` (or edit/remove), tap what *would* be a menu button
      if the keyboard were visible — since it's hidden, this isn't
      possible; confirm the keyboard truly disappeared after tapping
      "Add Item" and doesn't resurface until the flow ends
- [ ] Add a second chat ID to `ADMIN_IDS` (comma-separated) → that chat
      also gets Admin Mode and also receives order notifications
- [ ] A chat NOT in `ADMIN_IDS`/`ADMIN_CHAT_ID` never sees Admin Mode,
      regardless of what it sends — always the normal customer flow

## Admin commands

- [ ] From the admin chat: `/menu` lists current `menu_items` rows
- [ ] From the admin chat: `/close` → availability flips to `false` in
      Supabase, reply confirms
- [ ] From a non-admin chat while closed: any message → "kitchen is
      currently closed", order flow does not proceed
- [ ] From the admin chat: `/open` → availability flips back to `true`
- [ ] From the admin chat: `/orders` → lists the 10 most recent orders,
      newest first
- [ ] From the admin chat: `/settings` → shows kitchen status and the
      configured admin chat ID(s)
- [ ] From a **non-admin** chat: every admin command/button gets
      "not authorized" and does **not** change availability, return the
      menu, or reveal orders/settings

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
      change is made, admin is back to Admin Mode dashboard
- [ ] Send `/edititem` or `/removeitem` when the menu is empty → clear
      message, no crash, no numbered list of nothing
- [ ] From a **non-admin** chat: `/additem`, `/edititem`, `/removeitem`
      all get "not authorized" and cannot start a flow
- [ ] While mid-flow, send `/start` → flow is abandoned, session resets
      normally (no leftover draft interferes with the next conversation)

## Natural-language admin commands

- [ ] With "Burger" on the menu, from the admin chat try each of:
      `/edititem Burger 4000`, `/edit item burger 4000`,
      `edit burger 4000`, `burger 4000`, `burger is now 4000`,
      `change burger price to 4000`, `make burger 4500` → each updates
      Burger's price directly (no extra confirmation step), with a
      confirmation message and the keyboard restored
- [ ] `/removeitem Burger`, `remove burger`, `delete burger` → each
      shows the same confirmation prompt as the guided flow ("Remove
      'Burger' ... reply yes to confirm") — **not** an immediate delete
- [ ] `/additem Fries 1500`, `add fries 1500`, `new item fries 1500` →
      each adds a new "Fries" row (title-cased), available by default,
      no extra questions asked
- [ ] Typos: `burgr 4000`, `buger 4000`, `burgar 4000` → all still match
      "Burger" and update its price
- [ ] An item name that doesn't resemble anything on the menu (e.g.
      `xyzfood 500`) → one clarification question asking whether to add
      it as new or whether they meant an existing item — **no** row
      created or changed
- [ ] Two similarly-named items on the menu (e.g. "Chicken" and
      "Chicken Wings") — a clearly ambiguous typo between them → one
      clarification question listing both, no mutation until answered
- [ ] Ordinary admin chat ("thanks", "ok", "how's it going") → dashboard
      shown as usual, **no** clarification question, no menu lookup
      triggered
- [ ] Existing bare slash commands (`/additem` with no args, `/edititem`,
      `/removeitem`) still start the guided step-by-step flow exactly as
      before — inline-argument commands don't change this
- [ ] Existing keyboard buttons (➕ Add Item, ✏ Edit Item, ❌ Remove Item,
      etc.) still work exactly as before
- [ ] **From a non-admin/customer chat**, send the exact same text as
      any case above (e.g. "burger 4000", "remove burger", "add fries
      1500") → normal customer order-flow/FAQ handling only; menu is
      **never** modified and no admin-style response appears
- [ ] Confirm no Gemini call happens for any of the natural-language
      admin cases above (check server logs / Gemini usage — this is a
      fully deterministic parser, zero API calls)
- [ ] From the admin chat, type bare words (no slash, no emoji):
      `menu`, `orders`, `settings`, `open`, `close` → each triggers the
      matching action directly, same as the button/slash command

## Latency / timeout budget

- [ ] With a normal (fast) Gemini response, confirm total webhook
      response time is well under the route's `maxDuration` (10s) —
      should typically be 1-3s
- [ ] If reachable, simulate a slow/hanging Gemini response (e.g. a
      temporarily invalid `GEMINI_MODEL` that causes retries upstream,
      or throttle network in a local test) → the bot should fail into
      the fallback reply within ~6s, not hang until Vercel's own
      timeout fires

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
- [ ] `ADMIN_IDS` (preferred) or `ADMIN_CHAT_ID` (legacy fallback) set
      to real numeric chat id(s) — confirm setting either to an empty
      string is treated as "not configured" (Admin Mode and
      notifications should behave as if unset, not silently use chat id
      `0`)

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
- With more than one admin configured (`ADMIN_IDS` with multiple IDs),
  two admins editing the same menu item at nearly the same moment is a
  last-write-wins race — there's no row-level locking. Low risk for a
  small single-restaurant bot with occasional admin use; would need
  explicit locking or optimistic concurrency to fully close.
- There's a narrow (sub-second to a few seconds) window between
  `routeConversation` checking `isKitchenOpen()` and a customer's
  message actually finishing processing, during which an admin could
  close the kitchen. In that exact window, Gemini's "Kitchen: open"
  context could be very slightly stale for that one message. Negligible
  in practice, not actively guarded against.
