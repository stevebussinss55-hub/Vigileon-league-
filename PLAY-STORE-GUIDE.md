# Publishing Vigileon League on Google Play (Trusted Web Activity)

A TWA wraps your live site (https://league.vigileongh.com) in a thin Android app. Push
notifications, login and payments keep working because it IS the website — updates to the site
show up in the app without a new Play release.

## 0. READ FIRST — Play's real-money policy
Google Play's "Real-Money Gambling, Games, and Contests" policy prohibits apps where users pay
real money to enter a tournament/contest for cash prizes, unless the app is approved through
Google's gambling application with a valid license for each country. Vigileon's paid
tournaments, staked 1v1 challenges and wallet match that description, so a review is likely to
reject the app as-is. Options:
 a) Apply through Google's gambling/real-money application (needs licensing in Ghana; check
    the policy page for whether Ghana is eligible), or
 b) Submit a Play version without cash entry/prizes (free tournaments, no wallet/stakes) and
    keep the web version for paid play, or
 c) Skip Play and distribute the PWA / a direct APK from the website.
Also: the app icon shows third-party characters and real people (Call of Duty, Fortnite,
Valorant, Messi etc.). Play's impersonation/IP policy will reject that — use an original logo
for the Play listing and app icon.

## 1. Prerequisites
- Google Play developer account (one-time US$25, identity verification; new personal accounts
  must run a closed test with 12+ testers for 14 days before production).
- Site deployed on league.vigileongh.com over HTTPS (done), with the files in this zip.
- Privacy policy at a public URL (yours is inside the app at #terms — host it at its own URL
  like https://league.vigileongh.com/privacy.html for Play's form).
- Account deletion: Play requires an in-app way AND a web URL to request deletion.

## 2. Build the Android bundle (.aab)
Easiest: https://www.pwabuilder.com → enter https://league.vigileongh.com → Package for
stores → Android. Or with Bubblewrap CLI (needs Node + JDK):
    npm i -g @bubblewrap/cli
    bubblewrap init --manifest https://league.vigileongh.com/manifest.json
    bubblewrap build
`play-store/twa-manifest.json` is pre-filled (package id com.vigileon.league — change if you
want a different one; it can never change after publishing). Keep the generated .keystore safe.

## 3. Upload & link the domain
1. Play Console → Create app → upload the .aab to an internal/closed test.
2. Play Console → Setup → App signing → copy the SHA-256 certificate fingerprint.
3. Paste it into `.well-known/assetlinks.json` (replace REPLACE_WITH_SHA256...), redeploy.
4. Check https://league.vigileongh.com/.well-known/assetlinks.json opens. Without this the
   app shows a browser address bar instead of full-screen.

## 4. Store listing
512x512 icon, 1024x500 feature graphic, 2-8 phone screenshots, short (80) + full (4000 char)
description, content rating questionnaire, Data safety form (Firebase auth/Firestore,
Paystack, Resend email), target audience (18+ because of money features).

## 5. Notifications inside the app
enableNotifications is on, so web push (FCM) works through Chrome's TWA. On Android 13+
the user is asked for notification permission.
