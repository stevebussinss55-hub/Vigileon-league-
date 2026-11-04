# Timed jobs + automatic tournament reminders (vigileon-cron)

This is a SEPARATE small Cloudflare Worker (not part of the GitHub website files). It wakes up
every 5 minutes and does:

| What | When |
|---|---|
| Auto-cancel unanswered challenges + refund wallet stakes | every 5 min |
| Clean up stuck Quick Match queue entries + refund | every 5 min |
| Generate tournament brackets (full, or start time passed) | every 5 min |
| "⏰ Tournament starting soon" push to everyone who joined | ~1 hour before start |
| "📅 Tournament coming up" push to everyone who joined | once, 2-24 hours before start |
| "🔥 Last chance to join!" push to players who have NOT joined | last 3 hours before entries close |
| Admin daily digest push (only if something is waiting) | 08:00 every day |

Players can mute the reminders in their Notification Preferences (Tournaments). Muted players
still see the message in their in-app inbox.

## Set it up (about 5 minutes, works from a phone browser)
1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it `vigileon-cron` → **Deploy** (deploys the sample), then **Edit code**.
3. Delete the sample code, paste the ENTIRE contents of `vigileon-cron.js`, tap **Deploy**.
4. Worker → **Settings → Variables and Secrets** → add a **Secret**:
   `FIREBASE_SERVICE_ACCOUNT_JSON` = the same full JSON you used for the website.
5. Worker → **Settings → Triggers** → **Cron Triggers** → **Add** → `*/5 * * * *` → Save.
6. (Optional but recommended) add a **Variable** `CRON_TEST_KEY` = any long random text, deploy,
   then open this in a browser to try it WITHOUT changing anything:
   `https://vigileon-cron.<your-account>.workers.dev/?key=YOUR_KEY&job=all&dry=1`
   It lists what it WOULD do. Remove `&dry=1` to run for real. `job` can be
   `stale`, `brackets`, `reminders`, `digest` or `all`.
7. Check it is alive: Worker → **Logs** (Observability) shows a line each run, e.g.
   `stale: cancelled 0 ...`, `brackets: ...`, `reminders: ...`, `done (12 outbound calls)`.

## Free plan vs paid plan
Cloudflare's free plan lets one run make about 50 outbound calls. The Worker stays under that
(default limit 45) and spreads big jobs over several 5-minute runs. In practice:
- Reminders to people who joined go out 12 players per run (≈140 players in the hour before start).
- "Last chance" goes to ≈12 non-joined players per run (≈430 over its 3-hour window).
If you have more players than that, upgrade the Worker plan (US$5/month) and set variables
`SUBREQUEST_LIMIT` = 900 and `PUSH_CHUNK` = 150.

## Good to know
- Players only get a phone push if they allowed notifications on the NEW site address.
- A Paystack-paid challenge that expires is cancelled and flagged in your admin refund queue (a
  real card/MoMo reversal can't be done automatically). Wallet-paid stakes refund instantly.
- Delete the old `netlify` folder / scheduled settings; they are no longer used.
