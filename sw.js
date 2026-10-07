// This service worker does two jobs:
// 1. Exists at all — required for Chrome/Android to show the "Install app" prompt, and for
//    the site to work as a PWA. It doesn't cache anything, so it never serves stale content.
// 2. Shows push notifications (new match reports, payout requests, etc.) even when the app
//    or the browser itself is fully closed. That part only ever matters for the admin account
//    — the Cloud Function that triggers these only sends to whatever device the admin signed
//    into and granted notification permission on.

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

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
