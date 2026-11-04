// This service worker does three jobs:
// 1. Exists at all — required for Chrome/Android to show the "Install app" prompt, and for
//    the site to work as a PWA.
// 2. Keeps the app usable on weak/no data: the page and its images/icons are cached after the
//    first visit. The page itself is NETWORK-FIRST (so a new deploy always wins when online;
//    the cached copy is only used when offline or the network takes >5s). Data calls
//    (/api/*, Firebase, Paystack) are never cached.
// 3. Shows push notifications (match results, payout requests, etc.) even when the app or the
//    browser itself is fully closed.

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Service workers run in their own isolated scope with no access to the page's JS, so the
// Firebase config has to be repeated here. These are the same public values already in
// index.html — a Firebase apiKey is not a secret, so this is safe to have in both places.
firebase.initializeApp({
  apiKey: "AIzaSyAEPK1dKzCZRDawHg0n0lSQ8VIukQBNDk4",
  authDomain: "vigileon-league.firebaseapp.com",
  projectId: "vigileon-league",
  storageBucket: "vigileon-league.firebasestorage.app",
  messagingSenderId: "1076262699072",
  appId: "1:1076262699072:web:c0caba8afe181ae6359fa5"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'Vigileon League';
  const options = {
    body: (payload.notification && payload.notification.body) || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: (payload.data && payload.data.url) || '/' }
  };
  self.registration.showNotification(title, options);
});

// Tapping the notification opens (or focuses) the site instead of just dismissing it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

const CACHE = 'vigileon-shell-v1';
const PRECACHE = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png', '/favicon-32.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheCopy(request, response) {
  if (response && response.status === 200 && response.type === 'basic') {
    const copy = response.clone();
    caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // Firebase, fonts, Paystack: browser handles
  if (url.pathname.startsWith('/api/')) return;                    // email/push functions: never cache
  if (url.pathname === '/sw.js') return;                           // always fetch the newest worker
  if (url.searchParams.has('_v')) return;                          // the in-app "new update" checker must hit the network

  // The page itself: network first, cached copy only if offline or very slow.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const network = fetch(req).then((res) => cacheCopy(new Request('/'), res));
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
      try {
        const first = await Promise.race([network, timeout]);
        if (first) return first;
        const cached = await caches.match('/');
        return cached || network;                                   // nothing cached yet: keep waiting
      } catch (err) {
        const cached = await caches.match('/');
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // Images, icons, manifest, etc.: show the cached copy instantly and refresh it in the background.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const refresh = fetch(req).then((res) => cacheCopy(req, res)).catch(() => null);
    if (cached) { event.waitUntil(refresh); return cached; }
    return (await refresh) || Response.error();
  })());
});
