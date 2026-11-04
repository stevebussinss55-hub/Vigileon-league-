# Setting up push notifications on Netlify (no Firebase Blaze plan needed)

This replaces the old Firebase Cloud Functions setup. If you already deployed those
Cloud Functions earlier, you can safely delete them now — see the bottom of this file.

There are TWO separate things that both need to be set up before any push notification
can work — a missing VAPID key or a missing/misnamed service account will each independently
block every push, silently, with the app just doing nothing. Do both steps below.

## Step 1 — Generate a Web Push VAPID key (required for the browser side)

1. Firebase Console → your `vigileon-league` project → ⚙️ **Project settings**.
2. Go to the **Cloud Messaging** tab.
3. Scroll to **Web configuration** → **Web Push certificates**.
4. If none exists yet, click **Generate key pair**. Copy the resulting key string.
5. Open `index.html`, find the line near the top that says:
   ```
   const PUSH_VAPID_KEY = "PASTE_YOUR_VAPID_KEY_HERE";
   ```
   and replace `PASTE_YOUR_VAPID_KEY_HERE` with the key you copied, keeping the quotes.
6. Redeploy the site.

Without this, `setupPushNotifications()` detects the placeholder and quietly exits before
ever asking for notification permission — so no player, including you, will ever be asked
to allow notifications at all, and no push can ever be registered.

## Step 2 — Get a Firebase service account key (required for the server side)

This is what lets a Netlify function act with admin privileges on your Firestore data
(reading push tokens, sending messages) — same idea as an API key, but for Firebase itself.

1. Firebase Console → your `vigileon-league` project → ⚙️ **Project settings**.
2. Go to the **Service accounts** tab.
3. Click **"Generate new private key"** → confirm. This downloads a `.json` file —
   keep it safe, it's a real credential.

## Step 3 — Add it to Netlify

No conversion needed — paste the file's contents in directly as plain text.

1. Open the downloaded `.json` file in any text editor and copy its entire contents.
2. Netlify dashboard → your site → **Site configuration** → **Environment variables**.
3. Add a variable:
   - Key: `FIREBASE_SERVICE_ACCOUNT_JSON`
   - Value: paste the entire JSON file contents exactly as copied
4. Save, then trigger a fresh deploy (drag your site zip in again) so the function
   picks up the new variable.

**Never commit the original `.json` file or its contents to any public repo or share it
outside Netlify's environment variables.** Treat it like a password.

## Step 4 — Test it

Submit a piece of feedback or a payout request on your live site, then check:
- Netlify dashboard → **Functions** → `send-push` → look for a recent invocation and
  check its logs for errors, the same way you debugged `send-email` before.
- If your own device has notification permission granted, you should get a real push.
- If you still get nothing, check the **Functions** log first for the exact error rather
  than guessing — "Push notifications are not configured yet" specifically means Step 3
  wasn't saved correctly or the deploy didn't pick it up.

## You can now delete the old Firebase Cloud Functions (optional but recommended)

Since push notifications now run entirely on Netlify, the Cloud Functions in your
separate `vigileon-functions` project are no longer needed. To remove them and get
off the Blaze plan requirement:

```
cd vigileon-functions
firebase functions:delete notifyOnNewMatch notifyOnNewWithdrawalRequest notifyOnNewChallengePayoutRequest notifyOnNewTournamentEntry notifyOnNewFeedback
```

After that, you can downgrade your Firebase project back to the free **Spark** plan
from Firebase Console → bottom-left plan name → manage plan — as long as you're not
using any other Blaze-only feature.

---

# Setting up automated Paystack payouts

Reuses the same `FIREBASE_SERVICE_ACCOUNT_JSON` variable from above — nothing new needed
there. One additional variable is required:

1. Paystack Dashboard → **Settings** → **API Keys & Webhooks**.
2. Copy your **Secret Key** (starts with `sk_live_...` in live mode, `sk_test_...` in test
   mode — use test mode first if you want to try this with fake money before going live).
3. Netlify dashboard → your site → **Site configuration** → **Environment variables**.
4. Add a variable:
   - Key: `PAYSTACK_SECRET_KEY`
   - Value: the secret key you copied
5. Save, then trigger a fresh deploy so the function picks it up.

**Never put your secret key in `index.html` or anywhere else client-side** — unlike the
public key already in the code (which is safe to expose), the secret key can move money out
of your account and must only ever live in this one Netlify environment variable.

Two more things worth knowing:
- **Test with a small amount first.** The "Pay via Paystack" button moves real money the
  moment you confirm it — there's no draft/preview step.
- **If your Paystack account has OTP approval turned on for transfers** (Settings → Preferences
  → Transfers), a transfer will come back as "processing" instead of "paid" — you'll need to
  approve it once in the Paystack dashboard (Transfers tab) before the money actually moves.
  You can turn this off in Paystack if you'd rather transfers complete instantly, but that
  removes a safety check on their end too — your call.

