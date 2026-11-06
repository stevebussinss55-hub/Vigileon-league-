// _worker.js — single-file Cloudflare Pages worker (replaces the functions/ folder).
// Routes: POST /api/send-push, /api/send-email, /api/process-referral, /api/paystack-transfer, /api/wallet-adjust.
// Secrets: RESEND_API_KEY, FIREBASE_SERVICE_ACCOUNT_JSON, PAYSTACK_SECRET_KEY. Everything else serves the static site.
// Secrets needed: RESEND_API_KEY, FIREBASE_SERVICE_ACCOUNT_JSON.

// functions/_lib/google.js
//
// Tiny Google/Firebase helper for Cloudflare Pages Functions. The Netlify version used the
// firebase-admin SDK, which needs Node APIs that don't exist on Cloudflare Workers — so this
// does the same jobs over plain REST using only Web APIs (fetch + WebCrypto):
//   - signs a service-account JWT and exchanges it for an OAuth access token
//   - talks to Firestore (REST) and Firebase Cloud Messaging (HTTP v1)
//
// Files/folders starting with "_" are not turned into routes by Pages Functions.

function parseServiceAccount(raw) {
  const sa = JSON.parse(raw);
  // Pasting into a single-line env var box often turns real line breaks in the private key
  // into literal "\n" — convert them back before importing the key.
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
}

let cached = { token: null, exp: 0 };

export async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.exp - 60 > now) return cached.token;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/identitytoolkit',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const key = await importKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`));
  const jwt = `${header}.${claim}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google auth failed: ' + JSON.stringify(data));
  cached = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return cached.token;
}

function firestoreBase(sa) {
  return `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
}

async function gfetch(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}



// Reads pushTokens (array of strings) out of a Firestore REST document.
function tokensFromDoc(doc) {
  const vals = doc && doc.fields && doc.fields.pushTokens && doc.fields.pushTokens.arrayValue
    && doc.fields.pushTokens.arrayValue.values;
  return (vals || []).map(v => v.stringValue).filter(Boolean);
}

// functions/api/send-push.js  →  served at  POST /api/send-push
//
// Cloudflare Pages Function version of the old netlify/functions/send-push.js. Same inputs
// ({ target: 'admin' | 'player', uid?, title, body, url? }), same behavior: find the push
// tokens for the admin(s) or one player, send via Firebase Cloud Messaging, and remove tokens
// Firebase says are dead.
//
// Needs one secret in Cloudflare: FIREBASE_SERVICE_ACCOUNT_JSON (see CLOUDFLARE-SETUP.md).


const jsonPush = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function handleSendPush({ request, env }) {
  if (request.method !== 'POST') return jsonPush({ error: 'Method not allowed' }, 405);

  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.error('FIREBASE_SERVICE_ACCOUNT_JSON is not set in Cloudflare environment variables.');
    return jsonPush({ error: 'Push notifications are not configured yet.' }, 500);
  }

  let payload;
  try { payload = await request.json(); } catch (e) { return jsonPush({ error: 'Invalid JSON body.' }, 400); }

  const { target, uid, title, body, url } = payload || {};
  if (!title || !body) return jsonPush({ error: 'title and body are required.' }, 400);
  if (target !== 'admin' && target !== 'player') return jsonPush({ error: 'target must be "admin" or "player".' }, 400);
  if (target === 'player' && !uid) return jsonPush({ error: 'uid is required when target is "player".' }, 400);

  try {
    const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const token = await getAccessToken(sa);
    const base = firestoreBase(sa);

    const owners = []; // [{ docName, tokens }] — so dead tokens get removed from the right doc

    if (target === 'admin') {
      // Admins are listed by email in /admins; push tokens live on each admin's /users doc.
      const list = await gfetch(`${base}/admins?pageSize=100`, token);
      if (!list.ok) throw new Error('Could not read admins: ' + JSON.stringify(list.data));
      const emails = (list.data.documents || [])
        .map(d => decodeURIComponent(d.name.split('/').pop()))
        .slice(0, 30);
      if (emails.length) {
        const q = await gfetch(`${base}:runQuery`, token, {
          method: 'POST',
          body: JSON.stringify({
            structuredQuery: {
              from: [{ collectionId: 'users' }],
              where: { fieldFilter: {
                field: { fieldPath: 'email' }, op: 'IN',
                value: { arrayValue: { values: emails.map(e => ({ stringValue: e })) } }
              } }
            }
          })
        });
        if (!q.ok) throw new Error('Could not query users: ' + JSON.stringify(q.data));
        for (const row of q.data) {
          if (!row.document) continue;
          const t = tokensFromDoc(row.document);
          if (t.length) owners.push({ docName: row.document.name, tokens: t });
        }
      }
    } else {
      const r = await gfetch(`${base}/users/${encodeURIComponent(uid)}`, token);
      if (r.ok) {
        const t = tokensFromDoc(r.data);
        if (t.length) owners.push({ docName: r.data.name, tokens: t });
      }
    }

    const tokens = [...new Set(owners.flatMap(o => o.tokens))];
    if (tokens.length === 0) {
      return jsonPush({ success: true, note: 'No push tokens registered for this target — nothing to send.' });
    }

    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
    const results = await Promise.all(tokens.map(async (t) => {
      const r = await gfetch(fcmUrl, token, {
        method: 'POST',
        body: JSON.stringify({ message: { token: t, notification: { title, body }, data: { url: url || '/' } } })
      });
      const err = r.data && r.data.error;
      const dead = !r.ok && err && (
        err.status === 'NOT_FOUND' ||
        (err.details || []).some(d => d.errorCode === 'UNREGISTERED') ||
        (err.status === 'INVALID_ARGUMENT' && /registration token/i.test(err.message || ''))
      );
      if (!r.ok && !dead) console.error('FCM send failed:', JSON.stringify(r.data));
      return { token: t, ok: r.ok, dead };
    }));

    // Clean out tokens Firebase says are no longer valid.
    const deadTokens = results.filter(r => r.dead).map(r => r.token);
    for (const owner of owners) {
      const ownerDead = owner.tokens.filter(t => deadTokens.includes(t));
      if (!ownerDead.length) continue;
      await gfetch(`${base}:commit`, token, {
        method: 'POST',
        body: JSON.stringify({ writes: [{ transform: {
          document: owner.docName,
          fieldTransforms: [{ fieldPath: 'pushTokens',
            removeAllFromArray: { values: ownerDead.map(t => ({ stringValue: t })) } }]
        } }] })
      });
    }

    return jsonPush({ success: true, successCount: results.filter(r => r.ok).length });
  } catch (err) {
    console.error('send-push error:', err);
    return jsonPush({ error: err.message }, 500);
  }
}

// functions/api/send-email.js  →  served at  POST /api/send-email
//
// Cloudflare Pages Function version of the old netlify/functions/send-email.js. Sends an
// admin alert email via Resend for: tournament_payout, challenge_payout, feedback and
// player_report. The Resend key comes from the RESEND_API_KEY secret in Cloudflare — never
// from client code.

const jsonMail = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function handleSendEmail({ request, env }) {
  if (request.method !== 'POST') return jsonMail({ error: 'Method not allowed' }, 405);

  const RESEND_API_KEY = env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not set in Cloudflare environment variables.');
    return jsonMail({ error: 'Email service is not configured yet.' }, 500);
  }

  let payload;
  try { payload = await request.json(); } catch (e) { return jsonMail({ error: 'Invalid JSON body.' }, 400); }

  const { type } = payload || {};
  let subject, html;

  if (type === 'tournament_payout') {
    const { playerEmail, gamertag, tournamentName, momoNetwork, momoNumber } = payload;
    subject = '🚨 New Tournament Payout Request - Vigileon League';
    html = `
      <h3>New Tournament Payout Request Submitted!</h3>
      <p>A player has submitted a new payout request. Please check the Firestore console to approve it.</p>
      ${mailRow('Player', playerEmail)}
      ${mailRow('Gamertag', gamertag)}
      ${mailRow('Tournament', tournamentName)}
      ${mailRow('Mobile Money', [momoNetwork, momoNumber].filter(Boolean).join(' '))}
    `;
  } else if (type === 'challenge_payout') {
    const { playerEmail, opponentGamertag, amountGHS, momoNetwork, momoNumber } = payload;
    subject = '🚨 New 1v1 Challenge Payout Request - Vigileon League';
    html = `
      <h3>New 1v1 Challenge Payout Request Submitted!</h3>
      <p>A player has requested payout for a completed 1v1 challenge. Please check the Firestore console to approve it.</p>
      ${mailRow('Player', playerEmail)}
      ${mailRow('Beat opponent', opponentGamertag)}
      ${mailRow('Amount (GHS)', amountGHS)}
      ${mailRow('Mobile Money', [momoNetwork, momoNumber].filter(Boolean).join(' '))}
    `;
  } else if (type === 'feedback') {
    const { playerEmail, message } = payload;
    subject = '📝 New Feedback - Vigileon League';
    html = `
      <h3>New Feedback Submitted!</h3>
      <p>A player has sent feedback. Please check the Firestore console to read the full message.</p>
      ${mailRow('Player', playerEmail)}
      ${mailRow('Message', message)}
    `;
  } else if (type === 'player_report') {
    const { playerEmail, reportedName, reason } = payload;
    subject = '🚩 New Player Report - Vigileon League';
    html = `
      <h3>New Player Report Submitted!</h3>
      <p>A player has reported another player. Please check the Admin panel's Player Reports section for details.</p>
      ${mailRow('Reported by', playerEmail)}
      ${mailRow('Reported player', reportedName)}
      ${mailRow('Reason', reason)}
    `;
  } else {
    return jsonMail({ error: 'Unknown or missing "type" in request body.' }, 400);
  }

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Vigileon Alerts <onboarding@resend.dev>',
        to: 'tweneboahgideon55@gmail.com',
        subject,
        html
      })
    });
    const data = await resendRes.json();
    if (!resendRes.ok) {
      console.error('Resend API error:', data);
      return jsonMail({ error: data }, resendRes.status);
    }
    return jsonMail({ success: true, id: data.id });
  } catch (err) {
    console.error('Failed to reach Resend:', err);
    return jsonMail({ error: err.message }, 500);
  }
}

function mailRow(label, value) {
  if (!value) return '';
  return `<p><b>${mailEscape(label)}:</b> ${mailEscape(String(value))}</p>`;
}

function mailEscape(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ======================================================================================
   SHARED HELPERS FOR REFERRAL + PAYOUT ENDPOINTS
   ====================================================================================== */

const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// ---- Firestore REST value <-> JS ----
function fromV(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromV);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(fields) { const o = {}; for (const k in fields) o[k] = fromV(fields[k]); return o; }
function toV(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (x instanceof Date) return { timestampValue: x.toISOString() };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toV) } };
  const f = {}; for (const k in x) f[k] = toV(x[k]); return { mapValue: { fields: f } };
}
function toFields(obj) { const f = {}; for (const k in obj) f[k] = toV(obj[k]); return f; }

async function getDocObj(base, token, path) {
  const r = await gfetch(`${base}/${path}`, token);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('Firestore read failed: ' + JSON.stringify(r.data));
  return { data: fromFields(r.data.fields || {}), updateTime: r.data.updateTime, name: r.data.name };
}

// Merge-style write: only the listed fields change. deleteFields removes fields. If updateTime is
// given, the write only succeeds if the doc hasn't changed since it was read (optimistic lock).
async function patchDoc(base, token, path, obj, { deleteFields = [], updateTime = null } = {}) {
  const q = [];
  for (const k of [...Object.keys(obj), ...deleteFields]) q.push('updateMask.fieldPaths=' + encodeURIComponent(k));
  if (updateTime) q.push('currentDocument.updateTime=' + encodeURIComponent(updateTime));
  return gfetch(`${base}/${path}?${q.join('&')}`, token, { method: 'PATCH', body: JSON.stringify({ fields: toFields(obj) }) });
}
const isConflict = (r) => !r.ok && (r.status === 409 || r.status === 412 || (r.data && r.data.error && /FAILED_PRECONDITION|ABORTED/.test(r.data.error.status || '')));

async function addDoc(base, token, collectionPath, obj) {
  return gfetch(`${base}/${collectionPath}`, token, { method: 'POST', body: JSON.stringify({ fields: toFields(obj) }) });
}

async function createDocWithId(base, token, collectionPath, docId, obj) {
  return gfetch(`${base}/${collectionPath}?documentId=${encodeURIComponent(docId)}`, token, {
    method: 'POST',
    body: JSON.stringify({ fields: toFields(obj) })
  });
}

// Atomic server-side increment of one numeric field; returns the new value.
async function incrementField(sa, base, token, docPath, field, amount) {
  const docName = `projects/${sa.project_id}/databases/(default)/documents/${docPath}`;
  const inc = Number.isInteger(amount) ? { integerValue: String(amount) } : { doubleValue: amount };
  const r = await gfetch(`${base}:commit`, token, {
    method: 'POST',
    body: JSON.stringify({ writes: [{ transform: { document: docName, fieldTransforms: [{ fieldPath: field, increment: inc }] } }] })
  });
  if (!r.ok) throw new Error('Firestore increment failed: ' + JSON.stringify(r.data));
  const tr = r.data.writeResults[0].transformResults[0];
  return Number(tr.integerValue !== undefined ? tr.integerValue : tr.doubleValue);
}

// ---- Firebase ID token verification (RS256 against Google's public keys) ----
let jwksCache = { keys: null, at: 0 };
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function getJwks() {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600000) return jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const data = await res.json();
  if (!res.ok || !data.keys) throw new Error('Could not load Google signing keys');
  jwksCache = { keys: data.keys, at: Date.now() };
  return data.keys;
}
// Returns the token's claims, or throws if the token is invalid/expired/for another project.
async function verifyIdToken(idToken, projectId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  if (header.alg !== 'RS256') throw new Error('bad alg');
  const jwk = (await getJwks()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId) throw new Error('wrong audience');
  if (claims.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('wrong issuer');
  if (!claims.sub || claims.exp <= now || claims.iat > now + 300) throw new Error('expired');
  return claims;
}

// Push helper (same FCM call the send-push endpoint uses), for server-triggered notifications.
async function pushToTokens(sa, token, tokens, title, body, url) {
  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  await Promise.all(tokens.map(t => gfetch(fcmUrl, token, {
    method: 'POST',
    body: JSON.stringify({ message: { token: t, notification: { title, body }, data: { url: url || '/' } } })
  }).catch(() => null)));
}

/* ======================================================================================
   POST /api/process-referral
   Ported from netlify/functions/process-referral.js. Called once right after a new account
   signs up. Verifies the caller is that fresh account, then counts the referral and pays the
   milestone reward (every 10th referral) into the referrer's wallet.
   Safety change vs. the Netlify version: the "already processed" flag is claimed FIRST using
   an optimistic lock, so two simultaneous calls can never both credit the same signup.
   ====================================================================================== */
const MILESTONE_SIZE = 10, DEFAULT_REFERRAL_FEE_GHS = 5, MAX_ACCOUNT_AGE_MS = 10 * 60 * 1000;

async function handleProcessReferral({ request, env }) {
  if (request.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return jsonRes({ skipped: true });

  let payload; try { payload = await request.json(); } catch (e) { return jsonRes({ error: 'Invalid JSON body.' }, 400); }
  const { idToken } = payload || {};
  if (!idToken) return jsonRes({ error: 'idToken is required.' }, 400);

  try {
    const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    let claims;
    try { claims = await verifyIdToken(idToken, sa.project_id); }
    catch (e) { return jsonRes({ error: 'Invalid or expired session.' }, 401); }
    const newUid = claims.sub;
    const token = await getAccessToken(sa);
    const base = firestoreBase(sa);

    // Account must be a fresh signup. Preferred source: Firebase Auth's own creation time.
    let createdMs = null;
    const look = await gfetch(`https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/accounts:lookup`, token,
      { method: 'POST', body: JSON.stringify({ localId: [newUid] }) });
    if (look.ok && look.data.users && look.data.users[0] && look.data.users[0].createdAt) {
      createdMs = Number(look.data.users[0].createdAt);
    } else {
      console.warn('accounts:lookup unavailable, falling back to token auth_time:', JSON.stringify(look.data).slice(0, 200));
      createdMs = (claims.auth_time || 0) * 1000;
    }
    if (Date.now() - createdMs > MAX_ACCOUNT_AGE_MS) return jsonRes({ error: 'This account is not a fresh signup.' }, 403);

    const userPath = `users/${encodeURIComponent(newUid)}`;
    const newUser = await getDocObj(base, token, userPath);
    const nu = newUser ? newUser.data : {};
    if (nu.referralProcessed) return jsonRes({ alreadyProcessed: true });

    if (!nu.referredBy) {
      await patchDoc(base, token, userPath, { referralProcessed: true });
      return jsonRes({ noReferrer: true });
    }
    const referrerUid = nu.referredBy;
    if (referrerUid === newUid) { await patchDoc(base, token, userPath, { referralProcessed: true }); return jsonRes({ noReferrer: true }); }

    // Claim this signup (fails if another request got here first).
    const claim = await patchDoc(base, token, userPath, { referralProcessed: true }, { updateTime: newUser.updateTime });
    if (isConflict(claim)) return jsonRes({ alreadyProcessed: true });
    if (!claim.ok) throw new Error('Could not claim referral: ' + JSON.stringify(claim.data));

    const settings = await getDocObj(base, token, 'settings/global');
    const feeGHS = (settings && settings.data.referralMilestoneFeeGHS) || DEFAULT_REFERRAL_FEE_GHS;

    const referrerPath = `users/${encodeURIComponent(referrerUid)}`;
    const referrer = await getDocObj(base, token, referrerPath);
    if (!referrer) return jsonRes({ success: true, note: 'Referrer no longer exists.' });

    const newCount = await incrementField(sa, base, token, referrerPath, 'referralCount', 1);
    const hitMilestone = newCount % MILESTONE_SIZE === 0;
    if (hitMilestone) {
      await incrementField(sa, base, token, referrerPath, 'walletBalance', feeGHS);
      try {
        const now = new Date();
        await addDoc(base, token, 'walletTransactions', {
          uid: referrerUid, type: 'referral_bonus', amountGHS: feeGHS,
          note: newCount + ' friends referred — milestone reward', createdAt: now
        });
        const title = '🎉 Referral milestone reached!';
        const body = "You've referred " + newCount + ' friends — GHS ' + feeGHS + ' has been added to your wallet.';
        await addDoc(base, token, `${referrerPath}/notifications`, {
          type: 'payout_sent', title, text: body, url: '/#profile', fromUid: 'system', read: false, createdAt: now
        });
        const tokens = (referrer.data.pushTokens || []).filter(Boolean);
        if (tokens.length) await pushToTokens(sa, token, tokens, title, body, '/#profile');
      } catch (err) {
        console.error('Referral milestone logging/notification failed (reward was still credited):', err);
      }
    }
    return jsonRes({ success: true, referralCount: newCount, milestoneHit: hitMilestone, feeGHS: hitMilestone ? feeGHS : undefined });
  } catch (err) {
    console.error('process-referral error:', err);
    return jsonRes({ error: err.message }, 500);
  }
}

/* ======================================================================================
   POST /api/paystack-transfer      (MOVES REAL MONEY — admin only)
   Ported from netlify/functions/paystack-transfer.js. Same checks (valid admin ID token,
   amount re-read from the stored request, not already paid) plus two new guards:
     - a short "lock" so a double-tap can't send the payout twice
     - a request that already has a Paystack transfer started can't start another one
   Needs secrets: PAYSTACK_SECRET_KEY and FIREBASE_SERVICE_ACCOUNT_JSON.
   ====================================================================================== */
const NETWORK_TO_BANK_CODE = { MTN: 'MTN', Vodafone: 'VOD', AirtelTigo: 'ATL' };
const LOCK_MS = 120000;

async function handlePaystackTransfer({ request, env }) {
  if (request.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);
  const PAYSTACK_SECRET_KEY = env.PAYSTACK_SECRET_KEY;
  if (!PAYSTACK_SECRET_KEY) return jsonRes({ error: 'Automated payouts are not configured yet — PAYSTACK_SECRET_KEY is missing.' }, 500);
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return jsonRes({ error: 'Automated payouts are not configured yet — FIREBASE_SERVICE_ACCOUNT_JSON is missing.' }, 500);

  let payload; try { payload = await request.json(); } catch (e) { return jsonRes({ error: 'Invalid JSON body.' }, 400); }
  const { idToken, collection, requestId, challengeId, manualAmountGHS } = payload || {};
  if (!idToken || !collection || !requestId) return jsonRes({ error: 'idToken, collection, and requestId are required.' }, 400);
  if (collection !== 'withdrawalRequests' && collection !== 'challengePayoutRequests') return jsonRes({ error: 'Unknown collection.' }, 400);

  let sa, token, base, claims;
  try {
    sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    try { claims = await verifyIdToken(idToken, sa.project_id); }
    catch (e) { return jsonRes({ error: 'Your session has expired — sign in again and retry.' }, 401); }
    token = await getAccessToken(sa);
    base = firestoreBase(sa);
  } catch (err) { console.error('paystack-transfer setup error:', err); return jsonRes({ error: err.message }, 500); }

  const email = (claims.email || '').toLowerCase();
  let reqPath = `${collection}/${encodeURIComponent(requestId)}`;
  let lockHeld = false, lockUpdateTime = null;

  try {
    const adminDoc = email ? await getDocObj(base, token, `admins/${encodeURIComponent(email)}`) : null;
    if (!adminDoc) return jsonRes({ error: 'Only admins can trigger a payout.' }, 403);

    const reqDoc = await getDocObj(base, token, reqPath);
    if (!reqDoc) return jsonRes({ error: 'Payout request not found.' }, 404);
    const reqData = reqDoc.data;
    if (reqData.status === 'paid') return jsonRes({ error: 'This request has already been paid.' }, 409);
    if (reqData.transferReference) {
      return jsonRes({ error: 'A Paystack transfer was already started for this request (status: ' + (reqData.paystackTransferStatus || 'unknown') + '). Check your Paystack dashboard instead of sending again.' }, 409);
    }
    if (reqData.payoutLockAt && Date.now() - new Date(reqData.payoutLockAt).getTime() < LOCK_MS) {
      return jsonRes({ error: 'This payout is already being sent — wait a moment and refresh.' }, 409);
    }

    const network = reqData.momoNetwork || reqData.network;
    const momoNumber = reqData.momoNumber || reqData.number;
    const accountName = reqData.momoAccountName || reqData.accountName;
    const bankCode = NETWORK_TO_BANK_CODE[network];
    if (!bankCode) return jsonRes({ error: 'Unrecognized Mobile Money network: ' + network }, 400);

    let amountGHS = collection === 'challengePayoutRequests' ? reqData.amountGHS : (reqData.amountGHS || parseFloat(manualAmountGHS));
    if (!amountGHS || isNaN(amountGHS) || amountGHS <= 0) return jsonRes({ error: 'No valid payout amount for this request.' }, 400);

    // Take the lock (fails if someone else changed the doc since we read it).
    const lock = await patchDoc(base, token, reqPath, { payoutLockAt: new Date() }, { updateTime: reqDoc.updateTime });
    if (isConflict(lock)) return jsonRes({ error: 'This payout is already being sent — wait a moment and refresh.' }, 409);
    if (!lock.ok) throw new Error('Could not lock payout request: ' + JSON.stringify(lock.data));
    lockHeld = true;
    const release = () => patchDoc(base, token, reqPath, {}, { deleteFields: ['payoutLockAt'] }).catch(() => null);

    const psHeaders = { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' };
    const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
      method: 'POST', headers: psHeaders,
      body: JSON.stringify({ type: 'mobile_money', name: accountName || reqData.gamertag || reqData.userEmail || 'Vigileon League player', account_number: momoNumber, bank_code: bankCode, currency: 'GHS' })
    });
    const recipientData = await recipientRes.json();
    if (!recipientRes.ok || !recipientData.status) {
      await release();
      return jsonRes({ error: 'Paystack rejected the Mobile Money details: ' + (recipientData.message || 'unknown error') }, 502);
    }

    const transferRes = await fetch('https://api.paystack.co/transfer', {
      method: 'POST', headers: psHeaders,
      body: JSON.stringify({
        source: 'balance', amount: Math.round(amountGHS * 100), recipient: recipientData.data.recipient_code,
        reason: (collection === 'challengePayoutRequests' ? '1v1 challenge payout' : 'Tournament payout') + ' — Vigileon League',
        reference: 'VGL-PAYOUT-' + requestId + '-' + Date.now()
      })
    });
    const transferData = await transferRes.json();
    if (!transferRes.ok || !transferData.status) {
      await release();
      return jsonRes({ error: 'Paystack could not start the transfer: ' + (transferData.message || 'unknown error') }, 502);
    }

    // From here the money is on its way — record it. 'success' = paid; 'otp'/'pending' = queued.
    const transferStatus = transferData.data.status;
    const updates = {
      transferReference: transferData.data.reference, transferCode: transferData.data.transfer_code,
      payoutMethod: 'paystack_auto', paystackTransferStatus: transferStatus,
      status: transferStatus === 'success' ? 'paid' : 'processing'
    };
    if (transferStatus === 'success') updates.paidAt = new Date();
    const fin = await patchDoc(base, token, reqPath, updates, { deleteFields: ['payoutLockAt'] });
    lockHeld = false;
    if (!fin.ok) console.error('CRITICAL: transfer started but request doc update failed. ref=' + transferData.data.reference, JSON.stringify(fin.data));

    if (collection === 'challengePayoutRequests' && challengeId && transferStatus === 'success') {
      await patchDoc(base, token, `challenges/${encodeURIComponent(challengeId)}`, { payoutPaid: true }).catch(() => null);
    }

    if (reqData.userId) {
      try {
        const u = await getDocObj(base, token, `users/${encodeURIComponent(reqData.userId)}`);
        const tokens = ((u && u.data.pushTokens) || []).filter(Boolean);
        if (tokens.length) {
          await pushToTokens(sa, token, tokens,
            transferStatus === 'success' ? 'Your payout was sent' : 'Your payout is processing',
            transferStatus === 'success' ? `GHS ${Number(amountGHS).toFixed(2)} has been sent to your ${network} Mobile Money.` : 'Your payout is being processed and will land shortly.',
            '/#profile');
        }
      } catch (e) { /* non-blocking */ }
    }
    return jsonRes({ success: true, status: transferStatus, reference: transferData.data.reference, amountGHS });
  } catch (err) {
    console.error('paystack-transfer error:', err);
    if (lockHeld) await patchDoc(base, token, reqPath, {}, { deleteFields: ['payoutLockAt'] }).catch(() => null);
    return jsonRes({ error: err.message }, 500);
  }
}

/* ======================================================================================
   POST /api/wallet-adjust
   Server-side wallet balance changes for signed-in players. Stops clients from writing
   walletBalance directly in Firestore. Top-ups require a Paystack reference verified live.
   ====================================================================================== */
const WALLET_TYPE_RULES = {
  topup: { mustBePositive: true, needsReference: true },
  tournament_entry: { mustBePositive: false },
  challenge_stake: { mustBePositive: false },
  refund: { mustBePositive: true }
};

async function ensureUserDoc(base, token, userPath, email) {
  const existing = await getDocObj(base, token, userPath);
  if (existing) return;
  const r = await patchDoc(base, token, userPath, {
    walletBalance: 0,
    wins: 0,
    losses: 0,
    score: 0,
    email: email || ''
  });
  if (!r.ok) throw new Error('Could not initialize user profile for wallet: ' + JSON.stringify(r.data));
}

async function handleWalletAdjust({ request, env }) {
  if (request.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return jsonRes({ error: 'Wallet service is not configured yet.' }, 500);

  let payload;
  try { payload = await request.json(); } catch (e) { return jsonRes({ error: 'Invalid JSON body.' }, 400); }
  const { idToken, amountGHS, type, note, reference } = payload || {};
  if (!idToken || type == null || amountGHS == null) return jsonRes({ error: 'idToken, type, and amountGHS are required.' }, 400);
  const rules = WALLET_TYPE_RULES[type];
  if (!rules) return jsonRes({ error: 'Unknown wallet transaction type.' }, 400);

  const amountAbs = Math.round(Number(amountGHS) * 100) / 100;
  if (!amountAbs || isNaN(amountAbs) || amountAbs <= 0) return jsonRes({ error: 'Invalid amount.' }, 400);
  let signedAmount = rules.mustBePositive ? amountAbs : -amountAbs;

  try {
    const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    let claims;
    try { claims = await verifyIdToken(idToken, sa.project_id); }
    catch (e) { return jsonRes({ error: 'Invalid or expired session — sign in again.' }, 401); }
    const uid = claims.sub;
    const token = await getAccessToken(sa);
    const base = firestoreBase(sa);
    const userPath = `users/${encodeURIComponent(uid)}`;
    let creditAmount = amountAbs;

    if (rules.needsReference) {
      const ref = String(reference || '').trim();
      if (!ref) return jsonRes({ error: 'Paystack reference is required for top-ups.' }, 400);
      const lockId = ref.replace(/\//g, '_');
      const lockPath = `walletTopupLocks/${encodeURIComponent(lockId)}`;

      const PAYSTACK_SECRET_KEY = env.PAYSTACK_SECRET_KEY;
      if (!PAYSTACK_SECRET_KEY) return jsonRes({ error: 'Paystack is not configured for wallet top-ups (PAYSTACK_SECRET_KEY missing on the server).' }, 500);

      const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok || !verifyData.status) {
        return jsonRes({ error: 'Paystack verify request failed: ' + (verifyData.message || 'unknown error') }, 502);
      }
      const payStatus = verifyData.data && verifyData.data.status;
      if (payStatus !== 'success') {
        return jsonRes({ error: 'Paystack payment is not successful yet (status: ' + (payStatus || 'unknown') + '). Wait a few seconds and tap Retry credit.' }, 400);
      }
      creditAmount = Math.round((verifyData.data.amount / 100) * 100) / 100;
      if (creditAmount <= 0) return jsonRes({ error: 'Paystack returned an invalid paid amount.' }, 400);

      let lock = await getDocObj(base, token, lockPath);
      if (lock && lock.data.credited === true) {
        const balDoc = await getDocObj(base, token, userPath);
        return jsonRes({ success: true, alreadyProcessed: true, balance: (balDoc && balDoc.data.walletBalance) || 0 });
      }
      // Old bug: lock existed without crediting — allow repair if not marked credited
      if (lock && lock.data.credited !== true && lock.data.amountGHS) {
        creditAmount = Number(lock.data.amountGHS) || creditAmount;
      }

      if (!lock) {
        const lockCreate = await createDocWithId(base, token, 'walletTopupLocks', lockId, {
          uid, reference: ref, credited: false, amountGHS: creditAmount, createdAt: new Date()
        });
        if (!lockCreate.ok && !isConflict(lockCreate)) {
          return jsonRes({ error: 'Could not start top-up processing: ' + JSON.stringify(lockCreate.data) }, 500);
        }
        if (!lockCreate.ok) lock = await getDocObj(base, token, lockPath);
      }
      if (lock && lock.data.credited === true) {
        const balDoc = await getDocObj(base, token, userPath);
        return jsonRes({ success: true, alreadyProcessed: true, balance: (balDoc && balDoc.data.walletBalance) || 0 });
      }

      signedAmount = creditAmount;
    }

    await ensureUserDoc(base, token, userPath, claims.email || '');

    const userDoc = await getDocObj(base, token, userPath);
    const current = (userDoc && userDoc.data.walletBalance) || 0;
    const next = Math.round((current + signedAmount) * 100) / 100;
    if (next < 0) return jsonRes({ error: 'Insufficient wallet balance.' }, 400);

    let newBalance;
    try {
      newBalance = await incrementField(sa, base, token, userPath, 'walletBalance', signedAmount);
    } catch (incErr) {
      console.error('wallet-adjust increment failed:', incErr);
      return jsonRes({ error: 'Could not update wallet balance in the database. ' + incErr.message }, 500);
    }

    const txLog = await addDoc(base, token, 'walletTransactions', {
      uid,
      userEmail: claims.email || '',
      type,
      amountGHS: signedAmount,
      note: note || '',
      reference: reference || null,
      createdAt: new Date()
    });
    if (!txLog.ok) {
      console.error('wallet-adjust tx log failed (balance was still updated):', txLog.data);
    }

    if (rules.needsReference && reference) {
      const lockId = String(reference).trim().replace(/\//g, '_');
      const lockPath = `walletTopupLocks/${encodeURIComponent(lockId)}`;
      await patchDoc(base, token, lockPath, { credited: true, amountGHS: signedAmount, completedAt: new Date() }).catch(() => null);
    }

    return jsonRes({ success: true, balance: newBalance != null ? newBalance : next });
  } catch (err) {
    console.error('wallet-adjust error:', err);
    return jsonRes({ error: err.message }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/send-push') return handleSendPush({ request, env });
    if (pathname === '/api/send-email') return handleSendEmail({ request, env });
    if (pathname === '/api/process-referral') return handleProcessReferral({ request, env });
    if (pathname === '/api/paystack-transfer') return handlePaystackTransfer({ request, env });
    if (pathname === '/api/wallet-adjust') return handleWalletAdjust({ request, env });
    return env.ASSETS.fetch(request); // everything else = normal static site files
  }
};
