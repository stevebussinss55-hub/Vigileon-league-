
/* ======================================================================================
   CRON-SPECIFIC HELPERS
   ====================================================================================== */

// Cloudflare limits how many outbound calls (subrequests) one run may make: 50 on the free
// plan, 1000 on the paid plan. Every Google call is counted; when we get close, jobs stop
// politely and the next 5-minute run picks up where this one left off. Raise SUBREQUEST_LIMIT
// (and PUSH_CHUNK) in the Worker's variables if you move to the paid plan.
let used = 0;
let LIMIT = 45;
let DRY = false;
const LOGS = [];
const log = (...a) => { const line = a.join(' '); LOGS.push(line); console.log(line); };
function countCall() { if (used >= LIMIT) throw new Error('SUBREQUEST_BUDGET'); used++; }
const remaining = () => LIMIT - used;

const docRoot = (sa) => `projects/${sa.project_id}/databases/(default)/documents`;
const PROTECTED_READS = /:runQuery|:batchGet|oauth2\.googleapis\.com/;

function randomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(b, x => chars[x % chars.length]).join('');
}
const ms = (v) => (v ? new Date(v).getTime() : 0);
const idOf = (name) => decodeURIComponent(name.split('/').pop());

// Runs a Firestore query on a top-level collection. filters: [[field, '==' | '!=' | 'in', value], ...]
async function queryDocs(sa, base, token, collectionId, filters = [], { limit = null, orderById = false, startAfterId = null, select = null } = {}) {
  const OPS = { '==': 'EQUAL', '!=': 'NOT_EQUAL', 'in': 'IN' };
  const fl = filters.map(([f, op, v]) => ({ fieldFilter: { field: { fieldPath: f }, op: OPS[op], value: toV(v) } }));
  const sq = { from: [{ collectionId }] };
  if (fl.length === 1) sq.where = fl[0];
  else if (fl.length > 1) sq.where = { compositeFilter: { op: 'AND', filters: fl } };
  if (orderById) sq.orderBy = [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }];
  if (startAfterId) sq.startAt = { values: [{ referenceValue: `${docRoot(sa)}/${collectionId}/${startAfterId}` }], before: false };
  if (select) sq.select = { fields: select.map(f => ({ fieldPath: f })) };
  if (limit) sq.limit = limit;
  const r = await gfetch(`${base}:runQuery`, token, { method: 'POST', body: JSON.stringify({ structuredQuery: sq }) });
  if (!r.ok) throw new Error(`Query ${collectionId} failed: ` + JSON.stringify(r.data).slice(0, 300));
  return (r.data || []).filter(x => x.document).map(x => ({
    id: idOf(x.document.name), name: x.document.name,
    data: fromFields(x.document.fields || {}), updateTime: x.document.updateTime
  }));
}

async function deleteDoc(base, token, path, updateTime = null) {
  const q = updateTime ? '?currentDocument.updateTime=' + encodeURIComponent(updateTime) : '';
  return gfetch(`${base}/${path}${q}`, token, { method: 'DELETE' });
}

// Fetches users' push tokens + notification preferences in one call (up to 100 users).
async function getUsersPushInfo(sa, base, token, uids) {
  const info = {};
  const unique = [...new Set(uids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const r = await gfetch(`${base}:batchGet`, token, {
      method: 'POST',
      body: JSON.stringify({
        documents: chunk.map(u => `${docRoot(sa)}/users/${u}`),
        mask: { fieldPaths: ['pushTokens', 'notifPrefs'] }
      })
    });
    if (!r.ok) throw new Error('batchGet users failed: ' + JSON.stringify(r.data).slice(0, 300));
    for (const row of r.data || []) {
      if (!row.found) continue;
      const d = fromFields(row.found.fields || {});
      info[idOf(row.found.name)] = { tokens: (d.pushTokens || []).filter(Boolean), prefs: d.notifPrefs || {} };
    }
  }
  return info;
}

/* Delivers notifications: (1) always saves them to each player's in-app inbox (one batched
   write), then (2) sends a phone push to players who haven't muted that category, as far as
   the call budget allows. items: [{uid, type, title, body, url}] */
async function notifyUsers(sa, base, token, items, category, preloadedInfo = null, extraWrites = []) {
  if (!items.length && !extraWrites.length) return { inApp: 0, pushed: 0, committed: true };
  const now = new Date();
  const writes = items.filter(i => i.uid).map(i => ({
    update: {
      name: `${docRoot(sa)}/users/${i.uid}/notifications/${randomId()}`,
      fields: toFields({ type: i.type, title: i.title, text: i.body, url: i.url || null, fromUid: 'system', read: false, createdAt: now })
    },
    currentDocument: { exists: false }
  }));
  let inApp = 0, committed = true;
  const allWrites = [...extraWrites, ...writes];
  for (let i = 0; i < allWrites.length; i += 400) {
    const r = await gfetch(`${base}:commit`, token, { method: 'POST', body: JSON.stringify({ writes: allWrites.slice(i, i + 400) }) });
    if (r.ok) inApp += writes.length ? Math.min(400, allWrites.length - i) : 0;
    else { committed = false; log('WARN batched write failed:', JSON.stringify(r.data).slice(0, 200)); }
  }
  if (!items.length) return { inApp, pushed: 0, committed };
  const info = preloadedInfo || await getUsersPushInfo(sa, base, token, items.map(i => i.uid));
  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  let pushed = 0;
  for (const i of items) {
    const u = info[i.uid];
    if (!u || !u.tokens.length || u.prefs[category] === false) continue;
    for (const t of u.tokens.slice(-2)) {
      if (remaining() <= 1) { log('push budget reached — remaining pushes will be skipped this run'); return { inApp, pushed, committed }; }
      const r = await gfetch(fcmUrl, token, {
        method: 'POST',
        body: JSON.stringify({ message: { token: t, notification: { title: i.title, body: i.body }, data: { url: i.url || '/' } } })
      }).catch(() => null);
      if (r && r.ok) pushed++;
    }
  }
  return { inApp, pushed, committed };
}

// The wallet credit + its transaction-log entry, as writes to be committed together with the
// player's notification in ONE atomic call (all succeed or none do).
function refundWrites(sa, uid, amountGHS, note) {
  const root = docRoot(sa);
  const inc = Number.isInteger(amountGHS) ? { integerValue: String(amountGHS) } : { doubleValue: amountGHS };
  return [
    { transform: { document: `${root}/users/${uid}`, fieldTransforms: [{ fieldPath: 'walletBalance', increment: inc }] } },
    { update: { name: `${root}/walletTransactions/${randomId()}`, fields: toFields({ uid, type: 'refund', amountGHS, note, createdAt: new Date() }) }, currentDocument: { exists: false } }
  ];
}

/* ======================================================================================
   JOB 1 — Stale challenges + stale Quick Match queue (refunds)
   Port of check-stale-challenges.js. Each item is "claimed" with an optimistic lock first,
   so overlapping runs can never refund the same stake twice.
   ====================================================================================== */
const DEFAULT_CHALLENGE_EXPIRY_HOURS = 48;
const QUEUE_EXPIRY_MINUTES = 30;

async function jobStale(ctx) {
  const { sa, base, token } = ctx;
  const now = Date.now();
  const settings = await getDocObj(base, token, 'settings/global');
  const expiryHours = (settings && settings.data.challengeExpiryHours) || DEFAULT_CHALLENGE_EXPIRY_HOURS;

  let cancelled = 0, queue = 0;
  const stale = await queryDocs(sa, base, token, 'challenges', [['status', '==', 'awaiting_opponent_response']]);
  for (const c of stale) {
    const d = c.data; const created = ms(d.createdAt);
    if (!created || now - created < expiryHours * 3600000) continue;
    const walletFunded = String(d.challengerReference || '').startsWith('WALLET-');
    const updates = {
      status: 'cancelled', refundOwed: true,
      refundReason: 'Auto-cancelled — opponent never responded within ' + expiryHours + 'h',
      respondedAt: new Date(), autoCancelled: true
    };
    if (walletFunded) { updates.refundPaid = true; updates.refundPaidAt = new Date(); }
    const claim = await patchDoc(base, token, `challenges/${c.id}`, updates, { updateTime: c.updateTime });
    if (isConflict(claim)) continue;
    if (!claim.ok) { log('WARN could not cancel challenge', c.id, JSON.stringify(claim.data).slice(0, 150)); continue; }
    const extra = (walletFunded && d.challengerId)
      ? refundWrites(sa, d.challengerId, d.stakeGHS || 0, 'Auto-refund: challenge vs ' + (d.opponentGamertag || 'opponent') + ' expired unanswered') : [];
    const res = await notifyUsers(sa, base, token, [{
      uid: d.challengerId, type: 'dispute_filed', url: '/#challenges',
      title: 'Challenge auto-cancelled',
      body: (d.opponentGamertag || 'Your opponent') + ' never responded within ' + expiryHours + 'h, so it was cancelled' +
        (walletFunded ? ' and your stake was refunded to your wallet.' : ' — the admin will refund your stake shortly.')
    }], 'challenges', null, extra);
    if (extra.length && !res.committed) log('CRITICAL refund failed after cancelling challenge', c.id, 'uid', d.challengerId, 'amount', d.stakeGHS);
    cancelled++;
  }

  const waiting = await queryDocs(sa, base, token, 'matchmakingQueue', [['status', '==', 'waiting']]);
  for (const q of waiting) {
    const d = q.data; const joined = ms(d.joinedAt);
    if (!joined || now - joined < QUEUE_EXPIRY_MINUTES * 60000) continue;
    const del = await deleteDoc(base, token, `matchmakingQueue/${q.id}`, q.updateTime);
    if (isConflict(del) || !del.ok) continue; // someone matched/left at the same moment — leave it alone
    const res = await notifyUsers(sa, base, token, [{
      uid: d.uid, type: 'challenge_invite', url: '/#challenges', title: 'Quick Match timed out',
      body: 'No opponent was found for ' + d.game + ' · GHS ' + d.stake + ' within ' + QUEUE_EXPIRY_MINUTES + ' minutes — your stake was refunded to your wallet.'
    }], 'challenges', null, refundWrites(sa, d.uid, d.stake || 0, 'Auto-refund: Quick Match queue timed out with no opponent found'));
    if (!res.committed) log('CRITICAL queue refund failed uid', d.uid, 'amount', d.stake);
    queue++;
  }
  log(`stale: cancelled ${cancelled} challenge(s), cleaned ${queue} queue entr${queue === 1 ? 'y' : 'ies'}`);
}

/* ======================================================================================
   JOB 2 — Automatic tournament brackets   (port of check-tournament-brackets.js)
   ====================================================================================== */
function buildBracket(players) {
  let bracketSize = 2;
  while (bracketSize < players.length) bracketSize *= 2;
  const padded = players.slice();
  for (let i = 0; i < bracketSize - players.length; i++) padded.push({ uid: null, name: 'BYE', isBye: true });
  for (let i = padded.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [padded[i], padded[j]] = [padded[j], padded[i]];
  }
  const rounds = [];
  const round1 = [];
  for (let i = 0; i < padded.length; i += 2) round1.push({ p1: padded[i], p2: padded[i + 1], winner: null });
  rounds.push({ matches: round1 });
  let n = round1.length / 2;
  while (n >= 1) {
    const round = [];
    for (let i = 0; i < n; i++) round.push({ p1: null, p2: null, winner: null });
    rounds.push({ matches: round });
    n = n / 2;
  }
  round1.forEach((match, mi) => {
    const p1Bye = match.p1 && match.p1.isBye, p2Bye = match.p2 && match.p2.isBye;
    if (p1Bye || p2Bye) {
      const winnerPlayer = match[p1Bye ? 'p2' : 'p1'];
      match.winner = winnerPlayer;
      if (rounds.length > 1) rounds[1].matches[Math.floor(mi / 2)][mi % 2 === 0 ? 'p1' : 'p2'] = winnerPlayer;
    }
  });
  return { size: bracketSize, rounds };
}

async function jobBrackets(ctx) {
  const { sa, base, token } = ctx;
  const now = Date.now();
  const tournaments = await queryDocs(sa, base, token, 'tournaments');
  let generated = 0;
  for (const t of tournaments) {
    const d = t.data;
    if (d.bracket) continue;
    const started = d.startsAt && ms(d.startsAt) <= now;
    if (started && now - ms(d.startsAt) > 2 * 86400000) continue;        // started 2+ days ago with no bracket: entries are closed, stop checking
    if (!started && !d.maxParticipants) continue;                         // can't be ready yet — skip the lookup
    const entries = await queryDocs(sa, base, token, 'tournamentEntries', [['tournamentId', '==', t.id]]);
    if (entries.length < 2) continue;
    const isFull = d.maxParticipants && entries.length >= d.maxParticipants;
    if (!isFull && !started) continue;

    const players = entries.map(e => ({ uid: e.data.userId, name: e.data.gamertag || e.data.userEmail }));
    const bracket = buildBracket(players);
    const claim = await patchDoc(base, token, `tournaments/${t.id}`, { bracket, bracketAutoGeneratedAt: new Date() }, { updateTime: t.updateTime });
    if (isConflict(claim)) continue;
    if (!claim.ok) { log('WARN could not save bracket for', t.id, JSON.stringify(claim.data).slice(0, 150)); continue; }
    generated++;
    await notifyUsers(sa, base, token, players.filter(p => p.uid).map(p => ({
      uid: p.uid, type: 'bracket_ready', url: '/#tournaments', title: '🏆 Your bracket is up!',
      body: 'The bracket for "' + (d.name || 'your tournament') + '" has been generated — check who you\'re playing first.'
    })), 'tournaments');
  }
  log(`brackets: checked ${tournaments.length} tournament(s), generated ${generated}`);
}

/* ======================================================================================
   JOB 3 — Tournament reminders (NEW)
     • "Starting soon"  → everyone who joined, ~1 hour before the start time
     • "Coming up"      → everyone who joined, once, when the start is 2–24 hours away
     • "Last chance"    → players who have NOT joined yet, in the final hour before entries
                          close (endsAt), if the tournament isn't full
   Each reminder is sent once (flag saved on the tournament). The "last chance" broadcast goes
   out in small batches every 5 minutes (PUSH_CHUNK per run) so it never exceeds Cloudflare's
   per-run call limit; progress is saved on the tournament so it resumes where it stopped.
   Players can mute these in their Notification Preferences (Tournaments category).
   ====================================================================================== */
const mins = (n) => n * 60000;
const niceTime = (msLeft) => {
  const m = Math.max(1, Math.round(msLeft / 60000));
  return m >= 90 ? 'about ' + Math.round(m / 60) + ' hours' : 'about ' + m + ' minutes';
};

async function jobReminders(ctx) {
  const { sa, base, token, env } = ctx;
  const now = Date.now();
  const CHUNK = Math.max(1, Number(env.PUSH_CHUNK) || 12);
  const tournaments = await queryDocs(sa, base, token, 'tournaments');
  let sentEntrant = 0, sentBroadcast = 0;

  for (const t of tournaments) {
    const d = t.data;
    if (d.status === 'closed' || !d.name) continue;
    const startMs = ms(d.startsAt), endMs = ms(d.endsAt);
    const toStart = startMs ? startMs - now : null;
    const toEnd = endMs ? endMs - now : null;

    const needStartSoon = toStart !== null && toStart > 0 && toStart <= mins(60) && !d.reminderSoonSent;
    const needComingUp = toStart !== null && toStart > mins(120) && toStart <= mins(24 * 60) && !d.reminderDaySent;
    const needLastChance = toEnd !== null && toEnd > 0 && toEnd <= mins(180) && !d.reminderClosingDone;
    if (!needStartSoon && !needComingUp && !needLastChance) continue;
    if (remaining() < 8) throw new Error('SUBREQUEST_BUDGET');

    let entries = null;
    const getEntries = async () => entries || (entries = await queryDocs(sa, base, token, 'tournamentEntries', [['tournamentId', '==', t.id]]));

    // ---- reminders to people who joined (sent in batches of CHUNK; progress is saved) ----
    for (const kind of ['soon', 'day']) {
      if (kind === 'soon' && !needStartSoon) continue;
      if (kind === 'day' && !needComingUp) continue;
      const flag = kind === 'soon' ? 'reminderSoonSent' : 'reminderDaySent';
      const progressField = flag + 'Progress';
      const list = [...new Set((await getEntries()).map(e => e.data.userId).filter(Boolean))].sort();
      const progress = d[progressField] || 0;
      const slice = list.slice(progress, progress + CHUNK);
      if (!slice.length) { if (list.length) await patchDoc(base, token, `tournaments/${t.id}`, { [flag]: true }); continue; }
      const done = progress + slice.length >= list.length;
      const upd = { [progressField]: progress + slice.length };
      if (done) upd[flag] = true;
      const claim = await patchDoc(base, token, `tournaments/${t.id}`, upd, { updateTime: t.updateTime });
      if (isConflict(claim) || !claim.ok) continue;
      t.updateTime = (claim.data && claim.data.updateTime) || t.updateTime;
      const title = kind === 'soon' ? '⏰ Tournament starting soon' : '📅 Tournament coming up';
      const body = kind === 'soon'
        ? `"${d.name}" kicks off in ${niceTime(toStart)} — get ready to play!`
        : `"${d.name}" starts in ${niceTime(toStart)}. Be ready!`;
      const r = await notifyUsers(sa, base, token, slice.map(uid => ({ uid, type: 'tournament_reminder', url: '/#tournaments', title, body })), 'tournaments');
      sentEntrant += r.inApp;
    }

    // ---- last-chance broadcast to people who have NOT joined (batches; resumes next run) ----
    if (needLastChance) {
      const entrantIds = new Set((await getEntries()).map(e => e.data.userId));
      if (d.maxParticipants && entrantIds.size >= d.maxParticipants) {
        await patchDoc(base, token, `tournaments/${t.id}`, { reminderClosingDone: true });   // full — nothing to advertise
        continue;
      }
      let cursor = d.reminderClosingCursor || null;
      const targets = [];
      let exhausted = false;
      while (targets.length < CHUNK && remaining() > CHUNK + 4) {
        const page = await queryDocs(sa, base, token, 'users', [], { orderById: true, startAfterId: cursor, limit: 200, select: ['pushTokens', 'notifPrefs'] });
        if (!page.length) { exhausted = true; break; }
        let brokeEarly = false;
        for (const u of page) {
          cursor = u.id;
          const tokens = (u.data.pushTokens || []).filter(Boolean);
          if (!tokens.length || entrantIds.has(u.id) || (u.data.notifPrefs || {}).tournaments === false) continue;
          targets.push({ uid: u.id, tokens, prefs: u.data.notifPrefs || {} });
          if (targets.length >= CHUNK) { brokeEarly = true; break; }
        }
        if (brokeEarly) break;
        if (page.length < 200) { exhausted = true; break; }
      }
      if (targets.length) {
        const title = '🔥 Last chance to join!';
        const body = `Entries for "${d.name}" close in ${niceTime(toEnd)}. Join now before it's too late!`;
        const info = {}; targets.forEach(x => { info[x.uid] = { tokens: x.tokens, prefs: x.prefs }; });
        // save progress BEFORE sending, so an interrupted run can never message the same person twice
        const state = exhausted ? { reminderClosingDone: true } : { reminderClosingCursor: cursor };
        await patchDoc(base, token, `tournaments/${t.id}`, state, { deleteFields: exhausted ? ['reminderClosingCursor'] : [] });
        const r = await notifyUsers(sa, base, token, targets.map(x => ({ uid: x.uid, type: 'tournament_reminder', url: '/#tournaments', title, body })), 'tournaments', info);
        sentBroadcast += r.pushed;
      } else {
        const state = exhausted ? { reminderClosingDone: true } : { reminderClosingCursor: cursor };
        await patchDoc(base, token, `tournaments/${t.id}`, state, { deleteFields: exhausted ? ['reminderClosingCursor'] : [] });
      }
    }
  }
  log(`reminders: notified ${sentEntrant} entrant(s), pushed ${sentBroadcast} last-chance message(s)`);
}

/* ======================================================================================
   JOB 4 — Admin daily digest   (port of admin-daily-digest.js; runs once a day, 08:00 UTC)
   Says nothing at all on a quiet day.
   ====================================================================================== */
async function jobDigest(ctx) {
  const { sa, base, token } = ctx;
  const q = (c, f) => queryDocs(sa, base, token, c, f, { select: ['status'] });
  const [m, tp, cp, v, rf] = await Promise.all([
    q('matches', [['status', '==', 'pending']]),
    q('withdrawalRequests', [['status', 'in', ['pending', 'processing']]]),
    q('challengePayoutRequests', [['status', '!=', 'paid']]),
    q('verificationRequests', [['status', '==', 'pending']]),
    queryDocs(sa, base, token, 'challenges', [['refundOwed', '==', true], ['refundPaid', '==', false]], { select: ['status'] })
  ]);
  const counts = { matches: m.length, tp: tp.length, cp: cp.length, v: v.length, rf: rf.length };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) { log('digest: quiet day — nothing to send'); return; }
  const pl = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
  const lines = [];
  if (counts.matches) lines.push(pl(counts.matches, 'match result') + ' to review');
  if (counts.tp) lines.push(pl(counts.tp, 'tournament payout') + ' waiting');
  if (counts.cp) lines.push(pl(counts.cp, 'challenge payout') + ' waiting');
  if (counts.v) lines.push(pl(counts.v, 'identity verification') + ' to review');
  if (counts.rf) lines.push(pl(counts.rf, 'refund') + ' owed to players');
  const title = '📋 Daily admin digest — ' + pl(total, 'item') + ' waiting';
  const body = lines.join(' · ');

  const admins = await queryDocs(sa, base, token, 'admins', [], { select: ['x'] });
  const items = []; const info = {};
  for (const a of admins) {
    const u = await queryDocs(sa, base, token, 'users', [['email', '==', a.id]], { limit: 1, select: ['pushTokens', 'notifPrefs'] });
    if (!u.length) continue;
    items.push({ uid: u[0].id, type: 'admin_digest', url: '/#admin', title, body });
    info[u[0].id] = { tokens: (u[0].data.pushTokens || []).filter(Boolean), prefs: {} };
  }
  const r = await notifyUsers(sa, base, token, items, 'admin', info);
  log(`digest: sent to ${items.length} admin(s) (${r.pushed} push): ${body}`);
}

/* ======================================================================================
   SCHEDULER
   ====================================================================================== */
async function runJobs(env, only, scheduledTime) {
  used = 0; LOGS.length = 0;
  LIMIT = Number(env.SUBREQUEST_LIMIT) || 45;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) { log('FIREBASE_SERVICE_ACCOUNT_JSON is not set — nothing to do.'); return LOGS.join('\n'); }
  const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const when = new Date(scheduledTime || Date.now());
  const token = await getAccessToken(sa);
  const ctx = { sa, base: firestoreBase(sa), token, env };

  const plan = [];
  const want = (name) => !only || only === 'all' || only === name;
  if (want('stale')) plan.push(['stale', jobStale, 4]);
  if (want('brackets')) plan.push(['brackets', jobBrackets, 2]);
  if (want('reminders')) plan.push(['reminders', jobReminders, 4]);
  if ((only === 'digest') || (!only && when.getUTCHours() === 8 && when.getUTCMinutes() < 5)) plan.push(['digest', jobDigest, 3]);

  // Each job gets a fair share of the call budget (unused budget rolls on to the next job), so
  // a big backlog in one job can't starve the others.
  const total = LIMIT;
  for (let i = 0; i < plan.length; i++) {
    const [name, fn] = plan[i];
    const weightLeft = plan.slice(i).reduce((a, p) => a + p[2], 0);
    LIMIT = Math.min(total, used + Math.max(8, Math.floor((total - used) * plan[i][2] / weightLeft)));
    try { await fn(ctx); }
    catch (e) {
      if (e.message === 'SUBREQUEST_BUDGET') log(`${name}: call budget reached — continuing on the next run`);
      else log(`ERROR in ${name}:`, e.message);
    }
  }
  LIMIT = total;
  log(`done (${used} outbound calls)`);
  return LOGS.join('\n');
}

export default {
  // The 5-minute timer.
  async scheduled(event, env, ctx) {
    DRY = false;
    ctx.waitUntil(runJobs(env, null, event.scheduledTime));
  },
  // Optional manual test: https://<your-worker>.workers.dev/?key=<CRON_TEST_KEY>&job=all&dry=1
  // Only works if you set a CRON_TEST_KEY variable. dry=1 reads real data but changes nothing.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.CRON_TEST_KEY || url.searchParams.get('key') !== env.CRON_TEST_KEY) return new Response('Not found', { status: 404 });
    DRY = url.searchParams.get('dry') === '1';
    const out = await runJobs(env, url.searchParams.get('job') || 'all', Date.now());
    return new Response((DRY ? '[DRY RUN — nothing was written or sent]\n' : '') + out, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
};
