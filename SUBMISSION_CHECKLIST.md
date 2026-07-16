# Submission Checklist

## Code

- [ ] Repo pushed to GitHub (or wherever ForgePilot expects it), latest
      commit deployed
- [ ] `.env.local` / real secrets are **not** committed (`.gitignore`
      already excludes them — double-check `git status` before pushing)
- [ ] `npm run typecheck` passes with no errors
- [ ] `npm run build` succeeds locally before relying on Vercel's build

## Production environment

- [ ] Production Supabase project created, `supabase/schema.sql` run
      against it
- [ ] Real menu rows inserted into `menu_items`
- [ ] All env vars set in Vercel (see `DEPLOYMENT.md` table):
      `TELEGRAM_BOT_TOKEN`, `ADMIN_CHAT_ID`, `SUPABASE_URL`,
      `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `APP_BASE_URL`
- [ ] Deployed to Vercel, build green
- [ ] Telegram webhook registered against the production URL
      (`getWebhookInfo` confirms it, no `last_error_message`)

## Functional check (run `TESTING.md` against production, not just dev)

- [ ] Full order flow works end-to-end on the live deployment
- [ ] Admin gets the order notification
- [ ] `/open`, `/close`, `/menu` work for the admin, are rejected for
      everyone else
- [ ] Kitchen-closed message shows correctly for customers when closed

## Documentation

- [ ] `README.md` up to date (setup steps match what's actually needed)
- [ ] `DEPLOYMENT.md` reflects the real production setup used
- [ ] `FORGEPILOT_PLAN.md` accurately describes what's shipped vs
      deferred — no surprises for the reviewer
- [ ] `TESTING.md` checklist has actually been run at least once
      end-to-end

## Loom

- [ ] Recorded following `LOOM_CHECKLIST.md`
- [ ] Link works in a private/incognito window (permissions correct)
- [ ] Under whatever length limit ForgePilot specifies, if any

## Final submission

- [ ] Repo link, Loom link, and any credentials/test-account info
      ForgePilot asked for are gathered in one place
- [ ] Re-read the original ForgePilot requirements one more time against
      `FORGEPILOT_PLAN.md`'s "what's implemented" list — confirm nothing
      required was missed
- [ ] Submit
