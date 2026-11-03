// _worker.js — single-file Cloudflare Pages worker (replaces the functions/ folder).
// Routes: POST /api/send-push, POST /api/send-email. Everything else serves the static site.
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
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
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

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/send-push') return handleSendPush({ request, env });
    if (pathname === '/api/send-email') return handleSendEmail({ request, env });
    return env.ASSETS.fetch(request); // everything else = normal static site files
  }
};
