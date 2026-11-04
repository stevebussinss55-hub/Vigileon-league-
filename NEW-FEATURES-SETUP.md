# New features — setup notes

Four features were added to `index.html`: structured dispute resolution, a wallet/balance
system, tournament lobby chat, and seasonal leaderboard resets. The code is all in the
single `index.html` file, same as the rest of the site — no new files, no new dependencies.

**Important: you need to add Firestore Security Rules for the new collections/fields before
these features will actually work in production.** I've written the complete, ready-to-paste
rules file for you — see `firestore.rules.updated` in this zip (also pasted directly in chat).
It's your existing rules plus the additions below; nothing existing was removed, only one
existing rule (`matches` update/delete) was widened. Go to Firebase Console → Firestore
Database → Rules, and replace the contents with that file.

Summary of what changed, collection by collection:

## 1. Wallet (`walletTransactions` collection + `users/{uid}.walletBalance` field)
- A signed-in user should be able to **read** `walletTransactions` docs where `uid == request.auth.uid` (or where they're admin).
- A signed-in user should be able to **create** a `walletTransactions` doc where `resource.data.uid == request.auth.uid` (client writes these directly — same trust model your app already uses for `matches` and `feedback`).
- `users/{uid}` writes to `walletBalance` need to stay allowed for the doc owner (same as your existing `wins`/`losses`/`score` fields) — you likely don't need a rules change here if your existing rule already lets a user update their own `users/{uid}` doc.
- Consider whether you want users able to edit `walletBalance` directly (they currently can, via the same transaction that also writes `walletTransactions` — nothing stops a motivated user from writing an inflated balance directly through the console/devtools if your rule is a blanket "owner can write their own doc"). If you want this locked down tighter, walletBalance changes should really go through a Cloud Function that validates against the transaction log — happy to help set that up if you want it hardened later.

## 2. Tournament lobby chat (`tournamentChats/{tournamentId}/messages` subcollection)
- Uses a small companion collection, `tournamentChatMembers/{tournamentId}_{uid}`, written automatically the moment a player opens a tournament's lobby chat (the client already checks they've joined before allowing that). The chat rules then just do a plain `exists()` lookup on that doc — no query needed, and it self-heals access for anyone who joined the tournament before this feature existed, since it's written on every open, not just on entry.
- See the full rules text for the exact `tournamentChatMembers` and `tournamentChats` rules — already wired up on both the client and rules side, no further action needed beyond pasting the rules.

## 3. Dispute resolution (widened `matches` update/delete rule + new fields)
- Your existing rule only let `opponentUserId` (or admin) update a match doc. The dispute-response feature needs the **original reporter** (`resource.data.userId`) to also be able to update their own match doc — that's how they submit `claimantResponseText` / `claimantResponseProof` / `disputeStatus` / `disputeCoolOffEndsAt` / `disputeTimeline`. I widened the rule to include `resource.data.userId`, same trust level as the existing `opponentUserId` grant. Without this change, the "Respond to dispute" button would fail with a permissions error.

## 4. Seasons (`seasons` collection)
- Everyone (signed in or not) should be able to **read** `seasons` docs — the leaderboard page needs this to show season info to logged-out visitors too.
- Only admin should be able to **write** `seasons` docs (create/update).

---

## Feature summary

**Dispute resolution** — When a player disputes a reported result, both the dispute (reason +
counter-proof, already existed) and now a structured flow kick in: the original reporter gets
a "Respond to dispute" option (My Matches page) to add their own comment/evidence, which starts
a 24-hour cool-off period. The admin's dispute viewer shows a full timeline and warns (but
doesn't hard-block) if they try to resolve before cool-off ends.

**Wallet** — New "Wallet" nav tab. Players top up via Paystack once, then joining a tournament,
sending a challenge, or accepting one all offer "pay from wallet" as an option alongside a
fresh Paystack checkout, whenever the balance covers it. All wallet activity is logged to
`walletTransactions`.

**Tournament lobby chat** — A "💬 Lobby Chat" button appears on any tournament card once you've
joined it. Group chat scoped to that tournament, built on the same real-time listener pattern
as the existing 1-on-1 challenge chat.

**Seasonal leaderboard** — Your site's global points ladder was already retired in favor of
per-tournament standings, so the genuinely unbounded "early players can never be caught"
leaderboard still live today is the **1v1 Challenge Leaderboard** on the Challenges page
(ranked by completed cash challenges, all-time). That's the one seasons now apply to: admin
starts/ends seasons from a new "Leaderboard Seasons" card in the Admin page; ending a season
archives the top 20 finishers permanently (visible in a new "Past Seasons" section on the
Challenges page) and the leaderboard resets to zero for the next season. Until you start a
season, it behaves exactly as before (all-time) — nothing changes unless you opt in.
If you actually meant a different leaderboard, tell me which one and I'll retarget this.

**Automated Paystack payouts** — Admin's tournament/challenge payout queues now have a
"⚡ Pay via Paystack" button next to the existing manual one. It sends the payout straight
from your Paystack balance to the player's Mobile Money number via a new Netlify function
(`netlify/functions/paystack-transfer.js`), instead of you doing it by hand in the MTN/
Vodafone/AirtelTigo app. Setup: add a `PAYSTACK_SECRET_KEY` environment variable — full steps
in `DEPLOY-NOTES.md`. No Firestore rules changes were needed for this one (the transfer
function uses the Firebase Admin SDK, which bypasses client-side rules entirely — it instead
verifies the caller is a real signed-in admin itself, server-side).

**Structured tournament prizes → fully automatic tournament payouts (follow-up)** — Tournament
creation now has three extra fields: exact 1st/2nd/3rd place GHS amounts, separate from the
existing free-text prize description (which is still there for what players read — the exact
numbers are just for the payout logic). When a player requests a payout, their rank is
computed right then via the same standings logic the admin already sees, and if it's top 3
with a matching prize amount configured, that exact amount gets attached to the request.
"Pay via Paystack" now sends it immediately with no prompt when that amount is present — same
as challenge payouts — and only falls back to asking the admin for an amount on tournaments
that don't have structured prizes configured (or a rank outside the top 3). The server-side
function also now prefers the stored amount over anything the client sends, for the same
tamper-resistance reason challenge payouts already had.

One thing to know: **this only applies to withdrawal requests submitted after this update.**
Existing pending requests won't have an amount attached retroactively — the admin panel shows
"not set — enter manually" for those, same as before. New requests (or if a player deletes
and resubmits) will pick up the new logic once the tournament has prize amounts configured.

## Higher-stake anti-cheat verification (follow-up)

Above an admin-set GHS threshold, two extra safeguards kick in for challenges and tournament
matches. **Neither one needs Firebase Storage or the paid Blaze plan** — Storage now requires
Blaze even for small free-tier usage, so both pieces were built to stay entirely inside
Firestore's free Spark plan instead:

1. **Identity verification** — a player uploads a photo of a valid ID plus a selfie holding
   it (Profile page → "Identity Verification" card). Both photos are compressed and stored as
   base64 directly in the `verificationRequests` doc — the exact same technique your match
   screenshots already use — rather than uploaded to Storage. An admin reviews it in a new
   "Identity Verification Queue" in the Admin panel and approves/rejects. Once approved, it's
   a one-time thing — the `idVerified` flag stays on their account. Creating or accepting a
   challenge at or above the threshold is blocked (for either side) until both are verified.
2. **Video evidence** — reporting a result on a challenge or tournament match at or above the
   threshold shows an extra field asking for a **link** to a short video clip (not a file
   upload) — actual video files are too large to store in a Firestore document, and Storage
   isn't an option without Blaze. The player uploads their clip themselves to somewhere free
   (Google Drive, YouTube set to "Unlisted", WhatsApp, etc.) and pastes the share link. That
   link is what shows up in the admin's match review view, the dispute viewer, and the
   opponent-confirmation view as "▶ View video evidence" next to the screenshot.

Set the threshold in Admin → "Anti-Cheat: High-Stake Verification" (leave it blank/zero to
turn this off entirely — nothing is gated until a threshold is set). It applies to a
challenge's stake amount, or a tournament's entry fee, whichever is relevant to the match
being reported.

**New Firestore collections** (`settings`, `verificationRequests`) — rules are already in the
`firestore.rules.updated` file, no separate action needed there. **No Storage rules changes
needed at all** — this feature doesn't touch Storage anymore.

One tradeoff worth knowing: a pasted video link isn't something the platform controls the way
an uploaded file would be — a player could later delete/unshare it. That's an acceptable
tradeoff for a $0 setup, but worth knowing about. If you ever do move to the Blaze plan (it
has a generous free tier even once enabled — you're only billed for usage beyond that), true
file uploads could be reintroduced fairly easily.

## Notification / reminder center (follow-up)

Several events (challenge invites, disputes, match reviews, payouts, verification results)
previously only sent an OS-level push notification via `sendPushNotification()` — which does
nothing at all if the browser was never granted notification permission. That's exactly what
happened with the "opponent never got the challenge" issue earlier: the challenge itself was
created correctly, but with no permission granted there was genuinely no record anywhere
telling the opponent to check.

The fix is a new `notifyPlayer(uid, {...})` helper that all of those events now go through
instead. It does two things every time: writes a permanent entry to the player's in-app
notification inbox (the same `users/{uid}/notifications` collection your chat/DM bell
already used), *and* attempts the OS push as before. The in-app entry is the reliable part —
it's always there whether or not the push arrives.

Two visible changes:
- The notification bell dropdown now understands these new event types (with icons) and
  clicking one navigates to the right page, not just chat/DM threads like before.
- A new **Notifications** page (reachable via "View all notifications" at the bottom of the
  bell dropdown) shows your *complete* history, read or not — previously, anything marked
  read just disappeared with no way to look back at it.

No Firestore rules changes needed — every one of these writes happens through the currently
signed-in user's own session (a player disputing, or an admin approving/paying out), which
already satisfies the existing `fromUid == request.auth.uid` rule on that subcollection.

Chat messages, DMs, and incoming calls were left as-is — they already had their own in-app
bell entry logged separately, so routing them through `notifyPlayer` too would just double
them up.

Not included this round: per-category notification preferences (e.g. a toggle to mute
tournament announcements specifically). Everything currently notifies by default with no way
to opt out of a specific category — only the browser-level permission is all-or-nothing. Say
the word if you want that layer added.

## Automatic tournament bracket generation (follow-up)

Your tournaments already had a full bracket system (random pairing, byes for uneven player
counts, tap-to-advance winners) — it just needed an admin to click "Generate bracket" once
everyone had joined. That's now automatic.

**New file:** `netlify/functions/check-tournament-brackets.js`, a **Netlify Scheduled
Function** that runs every 5 minutes on its own — nobody needs to visit the site or click
anything. Each run checks every tournament that doesn't have a bracket yet, and generates one
the moment either condition is true (with at least 2 joined players either way):
- the tournament reached its max participant limit, or
- the tournament's start time has passed

It builds the exact same random-shuffle-with-byes bracket the manual button always did (the
pairing logic is copied line-for-line from the client code, so the data it writes is
identical), and notifies every entrant through the new in-app notification center + push the
moment their bracket is ready.

**Setup:** none beyond redeploying — this reuses the `FIREBASE_SERVICE_ACCOUNT_JSON` variable
already set up for your other functions, and the schedule itself is declared in
`netlify.toml` (`schedule = "*/5 * * * *"`), which Netlify picks up automatically on deploy.
After deploying, you can confirm it's active in Netlify Dashboard → your site → Functions —
`check-tournament-brackets` should show up there with its next scheduled run time. If Netlify
ever shows a message that Scheduled Functions need a plan upgrade, let me know and we can look
at an alternative (a client-triggered check would work as a fallback, just less reliable).

The manual button is still there for admin, relabeled "Generate bracket now (override)" — use
it only if you want to force pairing before the automatic check would normally trigger (e.g.
starting early with fewer players than the cap). Both paths now send the same "your bracket is
ready" notification to every entrant.

## Notification preferences (follow-up)

A new "Notification Preferences" card on the Profile page lets each player toggle 5 categories
on/off for themselves: Challenges & matches, Payouts, Tournaments, Account, and Messages.
Turning one off only stops the **push** notification for that category — the in-app
Notifications page always records everything regardless, so muting something can never make a
player lose track of it entirely, just quieter. All 5 default to on for every player (nothing
changes for anyone until they actually open the card and change something).

Stored as `notifPrefs` on the player's own `users/{uid}` doc (a plain object of booleans) —
already covered by your existing "owner can write their own user doc" rule, so no Firestore
rules changes needed.

## Four follow-ups: auto-expiring challenges, admin digest, personal stats, Quick Match

### Auto-expire unanswered challenges
A challenge that sits unanswered used to require the challenger to notice and manually cancel
it, then wait for an admin to manually refund them. A new scheduled function,
`netlify/functions/check-stale-challenges.js`, checks every 30 minutes for challenges stuck
in `awaiting_opponent_response` past a configurable expiry window (Admin → "Unanswered
Challenge Expiry", defaults to 48h) and auto-cancels them. **Wallet-funded stakes are refunded
automatically** the instant this fires — no admin step needed. Paystack-funded stakes still
land in your existing manual refund queue (Admin → challenge refunds), same as before, since
a real payment reversal isn't something a background job should do unattended.

### Admin daily digest
`netlify/functions/admin-daily-digest.js` runs once a day (08:00 UTC = 8am Ghana time) and
sends every admin a single notification summarizing anything waiting on them: pending match
reviews, tournament/challenge payout requests, verification requests, and refunds owed. On a
genuinely quiet day with nothing to report, it sends nothing at all — an empty digest every
morning just trains people to ignore it.

### Personal stats page
A new "Your Stats" card at the top of the Profile page: win rate, W-L record, current/best
streak, 1v1 net GHS earnings, biggest single win, and a per-game breakdown. Most of this
(wins, losses, streaks, per-game stats) was already being tracked on your user docs for
badges/leaderboards — this just surfaces it as its own view. Net earnings and biggest win are
newly computed from completed 1v1 challenges.

### Quick Match (opponent finder)
A new "⚡ Quick Match" card on the Challenges page — pick a game and stake, pay it, and get
paired automatically with the next player looking for the same thing (or join a queue and get
matched the instant someone else does). **Deliberately wallet-only, not Paystack** — instant
matching means a queued player might cancel any second, and only a wallet credit can refund
that fast; a real Paystack refund can't happen instantly, so allowing both payment methods
here would mean some cancellations refund immediately and others don't, which is confusing
and arguably unfair. If someone waits 30 minutes with no match, the same scheduled function
above auto-refunds them.

**Race safety:** matching runs inside a Firestore transaction that re-checks the candidate is
still waiting before claiming them — this is what stops two different players from both
grabbing the same waiting opponent if they search at the exact same moment. If that happens,
the losing side just falls through to queueing themselves instead of erroring.

**New Firestore rules needed** (already in `firestore.rules.updated`, no further action):
a `matchmakingQueue` collection where any signed-in player can flip *another* player's entry
from `waiting` to `matched` (that's how pairing works) but literally cannot touch any other
field on it — only the owner can create, modify their own fields, or delete their entry.

### Setup for all four
Nothing beyond redeploying — all three new scheduled functions reuse the existing
`FIREBASE_SERVICE_ACCOUNT_JSON` variable, and their schedules are declared in `netlify.toml`
the same way the bracket checker's was. After deploying, Netlify Dashboard → your site →
Functions should show `check-stale-challenges` and `admin-daily-digest` alongside
`check-tournament-brackets`, each with its next run time.

One thing worth knowing: the admin digest's query on `challengePayoutRequests` uses a "not
equal to paid" filter, which Firestore sometimes wants a composite index for — if that
specific part ever fails, Firestore's own error message includes a direct link that creates
the missing index with one click; nothing for you to configure manually up front.

## Bracket reporting + auto-advance (follow-up)

Two related gaps in the bracket system, now closed:

1. **Reporting a bracket match** — the bracket previously had no way for a player to actually
   report their result; only admin manually tapping a name in the bracket UI. Now, if you're
   one of the two players in an unresolved bracket matchup, a "📤 Report this match" button
   shows right under it, dropping you into the same Report page + screenshot flow challenges
   already used, with the tournament and opponent pre-filled.
2. **Auto-advancing the bracket** — confirming that report used to still require the admin to
   separately go tap the bracket to record the winner. Now, the moment an admin confirms a
   tournament match report, the matching bracket matchup (if the tournament has a bracket and
   this pair is genuinely still waiting in it) advances automatically — the winner gets
   notified they moved on (or, if it was the final, that they're the champion). The manual
   tap-to-advance is still there for anything that doesn't go through match reporting.

No Firestore rules or scheduled-function changes needed — this is entirely client-side logic
inside the existing admin match-review flow.

## Expanded game list (follow-up)

The site previously had "eFootball" and "Call of Duty" hardcoded in about a dozen separate
places — every dropdown, every colored tag, the per-game stats tracker, even the AI
assistant's own game list. All of that now reads from one central `GAMES` array in the code,
which currently lists: eFootball, Call of Duty, PUBG Mobile, Free Fire, FC 25, NBA 2K, Tekken,
and Mortal Kombat — each with its own tag color.

Every game dropdown (tournament creation, challenge creation, Quick Match, report a match)
also has an **"Other" option with a free-text field** — so a player can challenge or report on
literally any game not in the fixed list, typed in by hand. That custom text is stored and
displayed exactly as typed; it just gets a neutral gray tag color instead of one of the 8
named ones, since there's no way to pre-assign a color to a name that isn't known ahead of
time.

Adding another named game in the future (with its own color) is now a matter of adding one
line to the `GAMES` array — no more hunting through a dozen places in the file.

No Firestore rules or scheduled-function changes needed — this is entirely client-side.

## Referral program (follow-up)

There was already a small referral mechanic (bonus points toward the old, now-hidden global
leaderboard, awarded on the referred player's first tournament match) — that's left running
as-is, it's harmless. This is a new, separate, **cash** referral program layered on top:

Every player now has a **"🎁 Refer Friends" card** on their Profile page — it didn't exist
before (the site could already capture a `?ref=` link on signup, but had no UI anywhere for a
player to actually get their own link to share). It shows their personal referral link, a
copy button, how many friends they've referred, and progress toward the next reward.

**Every 10 friends who sign up through someone's link earns them a configurable GHS amount**
(Admin → "Referral Program", defaults to GHS 5) credited straight to their wallet —
automatically, repeating every 10 (10, 20, 30, and so on).

**Why this needed a new server-side function**, `netlify/functions/process-referral.js`:
crediting *another* player's wallet is exactly the kind of write your Firestore rules
correctly block a regular client from doing (a user can only ever write their own `users/{uid}`
doc) — and that's the right call, so this doesn't route around it by loosening the rule.
Instead, right after a new account finishes signing up, the client calls this function with
their ID token; it verifies that's a real, currently-valid session, checks the account was
genuinely created in the last 10 minutes (so the endpoint can't be replayed later), then
credits the *referrer's* wallet using the Admin SDK, which is allowed to write any document.

**One tradeoff worth being upfront about:** rewarding at signup (rather than, say, the
referred player's first confirmed match) is simpler and pays out immediately, but it's also
easier to game — someone could create 10 throwaway accounts through their own link to pay
themselves GHS 5. The 10-minute freshness check stops the reward from being replayed after
the fact, but doesn't stop someone determined to create real fake accounts in the first
place — no signup-triggered referral program fully solves that. If it becomes a real problem,
the two standard levers are: lower the reward amount, or move the trigger to "referred
player's first confirmed match played" instead (a heavier change — the original points-based
mechanic already works that way, so this is very doable if you want it later).

No Firestore rules changes needed — every client-side write here is a user writing their own
document, already covered by existing rules; everything else happens through the Admin SDK.

## Ludo, Dame, and Spades added (follow-up)

Three more games added to the central list: **Ludo**, **Dame** (Draughts), and **Spades** —
each with its own tag color, in all four game pickers (tournament creation, challenge
creation, Quick Match, report a match) alongside the 8 video games from before. For "spar," I
went with Spades the card game since it was grouped with Ludo and Dame — the classic trio of
everyday money games in Ghana — let me know if you meant something else.

## Email verification (removed)

This was added and then removed at your request — signing up no longer requires confirming
an email address; accounts work immediately after signup, same as before either feature
existed. No trace of it left in the code (the gate, the resend flow, the custom verification
link handling) — just noting it here since it did briefly exist in an earlier version of this
file if you're comparing deploys.

## Support tickets (follow-up)

The existing Feedback box was one-way (a player sends a message, you mark it read) — this
adds a real back-and-forth conversation thread for a specific issue, same page (now titled
"Feedback & Support"), separate section below it.

A player opens a ticket with a subject and description; it shows up in a new **"Support
Tickets"** section in Admin (open ones sorted first, with an unread-count badge), and tapping
one opens a chat-style conversation — same pattern as the existing challenge chat — where
either side can reply. Admin can mark a ticket resolved or reopen it from inside that same
view. Both sides get notified when the other replies (through the notification center built
earlier, so it shows up even if push notifications aren't granted).

**New Firestore rules** (already in `firestore.rules.updated`, no further action needed): a
`supportTickets` collection readable/writable by the ticket's owner or admin, plus a
`messages` subcollection following the same pattern as your existing challenge-chat messages
rule — anyone in the conversation can read and post, nobody can edit or delete a message once
sent.

## Responsible gambling tools

Two tools live in a new "🛡 Responsible Gambling" card on the Profile page:

1. **Personal stake limit** — a player caps how much they can stake in any single challenge,
   tournament entry, or Quick Match. **Lowering or clearing the limit is instant; raising an
   existing limit is delayed 24 hours.** That's deliberate, not a bug — an instant increase
   would let the limit be undone in the exact moment it's meant to protect against ("I'll
   just raise it right now"). The old, lower limit stays in force until the delay passes.

2. **Self-exclusion** — a player locks themselves out of joining anything new (challenges,
   tournament entries, Quick Match) for 24 hours, 7 days, 30 days, or 90 days.
   **Deliberately cannot be undone early by anyone, including you as admin** — that's what
   makes a self-exclusion tool actually work rather than just being a suggestion. It doesn't
   block anything else (reporting matches already in progress, withdrawing wallet funds,
   signing in) — only starting something new.

**Enforced in two layers, not just one:**
- Client-side, at all four money-committing actions (send/accept challenge, join tournament,
  join Quick Match) — this is what a normal player actually experiences.
- **Also at the Firestore rules level**, for the three "create something new" actions
  (challenge, tournament entry, Quick Match queue entry) — already in
  `firestore.rules.updated`, paste it in like before. This matters because a client-side-only
  check can be bypassed by someone technical enough to call the Firestore API directly
  (browser devtools, etc.) — the rules-level check can't be bypassed that way, since it's
  enforced by Firebase itself, not by code running in the player's browser.

**One honest limitation:** the rules-level hardening covers *creating* a challenge, tournament
entry, or queue entry, but not the *accepting* side of an existing challenge (that's still a
generic "update" rule shared with cancel/decline/other legitimate flows, and safely carving
out just the accept transition needs more careful conditional rules than this covers). The
client-side gate does cover accepting — this is a real, narrow gap for anyone determined
enough to bypass the UI specifically on that one action, not something a normal player would
ever encounter.


