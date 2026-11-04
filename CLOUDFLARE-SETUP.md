# Cloudflare setup (email + push notifications)

Netlify Functions (`/.netlify/functions/...`) don't run on Cloudflare. Email and push now live in
`functions/api/send-email.js` and `functions/api/send-push.js` (Cloudflare Pages Functions),
and `index.html` calls `/api/send-email` and `/api/send-push`.

## 1. Deploy WITH the functions folder
Cloudflare's dashboard drag-and-drop upload ignores the `functions` folder. Use either:
- **Git integration** (connect the repo to Pages), or
- **Wrangler:**  `npx wrangler pages deploy . --project-name <your-pages-project>`

## 2. Add two secrets
Cloudflare dashboard → Workers & Pages → your project → Settings → Variables and Secrets (Production):
- `RESEND_API_KEY` — same value you used on Netlify
- `FIREBASE_SERVICE_ACCOUNT_JSON` — full contents of the Firebase service-account .json
Then redeploy so they take effect.

## 3. Firebase Authentication
Firebase Console → Authentication → Settings → Authorized domains → add your Cloudflare domain
(`league.vigileongh.com`, plus `*.pages.dev` if you use it), or logins fail on the new domain.

## 4. Re-enable push on the new domain
Push tokens are tied to the site's origin. Anyone who installed the app / allowed notifications
on the old netlify.app address must open the NEW address, sign in and allow notifications again
(and reinstall the app to the home screen).

## Not yet ported (still Netlify-only)
process-referral, paystack-transfer (⚡ Pay via Paystack button), and the scheduled jobs
check-tournament-brackets, check-stale-challenges, admin-daily-digest (need Cron Triggers).
