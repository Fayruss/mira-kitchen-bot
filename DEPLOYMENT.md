# Deployment Guide (Production)

This is the runbook for taking Mira's Kitchen Bot from local dev to a
live Vercel deployment. For local setup, see `README.md`.

---

## 1. Supabase (production project)

1. Create a Supabase project for production (separate from any dev/test
   project you used while building, so test orders and test sessions
   never mix with real ones).
2. Open the SQL Editor and run `supabase/schema.sql`. This creates:
   - `conversation_sessions`
   - `orders`
   - `availability` (seeded with `is_open = true`)
   - `menu_items`
3. Add your real menu:
   ```sql
   insert into menu_items (name, price, available) values
     ('Fried Rice', 8, true),
     ('Noodles', 7, true);
   ```
4. From Project Settings → API, copy:
   - **Project URL** → becomes `SUPABASE_URL`
   - **service_role key** (not the anon key) → becomes
     `SUPABASE_SERVICE_ROLE_KEY`

   The service role key bypasses Row Level Security and must never be
   exposed to a browser. This project only ever uses it inside server-side
   API routes, which is safe.

---

## 2. Telegram bot

1. If you haven't already, create the bot via [@BotFather](https://t.me/BotFather)
   and grab the bot token.
2. Get the admin's (Mira's) Telegram chat id — message
   [@userinfobot](https://t.me/userinfobot) from the account that should
   be able to run `/open`, `/close`, `/menu` and receive order
   notifications.

Webhook registration happens after deployment (step 4), once you have a
real HTTPS URL to point Telegram at.

---

## 3. Deploy to Vercel

**Option A — Vercel dashboard**
1. Push this project to a GitHub repo.
2. In Vercel: New Project → import the repo. Framework preset
   (Next.js) is auto-detected, no build config changes needed.
3. Add the environment variables below before the first deploy (or
   right after — you can redeploy anytime).
4. Deploy.

**Option B — Vercel CLI**
```bash
npm i -g vercel
vercel login
vercel --prod
```
Follow the prompts to link/create the project, then set env vars either
via the CLI (`vercel env add`) or the dashboard.

### Environment variables to set in Vercel (Production)

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `ADMIN_CHAT_ID` | Mira's Telegram chat id |
| `SUPABASE_URL` | production Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | production service role key |
| `GEMINI_API_KEY` | Gemini API key |
| `APP_BASE_URL` | your production URL, e.g. `https://mira-kitchen-bot.vercel.app` |

After adding/changing env vars, redeploy so the running instance picks
them up.

---

## 4. Register the production webhook

Once deployed, point Telegram at the live URL:

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<APP_BASE_URL>/api/telegram
```

Confirm it registered:

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo
```

Look for `"url"` matching your deployment and `"last_error_message"`
absent. If you ever redeploy to a new URL (e.g. a new Vercel project),
re-run `setWebhook` with the new URL.

---

## 5. Post-deploy smoke test

Run through `TESTING.md`'s checklist against the live deployment, at
minimum:

- [ ] Message the bot as a normal customer → full order flow completes
- [ ] Admin chat gets the 🍽️ New Order notification
- [ ] `/open`, `/close`, `/menu` work from the admin chat and are
      rejected from any other chat
- [ ] Order and session rows appear correctly in the production Supabase
      project

---

## 6. Rolling back / redeploying

- Vercel keeps previous deployments — use the dashboard's "Promote to
  Production" on an earlier deployment if a release causes problems.
- No database migrations to reverse for this MVP (schema is additive
  only, applied once from `supabase/schema.sql`).
- Rotating `TELEGRAM_BOT_TOKEN` or Supabase keys: update in Vercel env
  vars, redeploy, and re-run `setWebhook` if the token changed.
