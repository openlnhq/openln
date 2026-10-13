// openLN service worker.
// Job one: give the installed app a branded offline page instead of the
// browser's default error screen. Everything else stays a network
// pass-through on purpose: /app and /api are served no-store so phones never
// run stale code, and this worker must not change that.
const CACHE = 'openln-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })).catch(() => {}))
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

// Keep a fetch listener even though only navigations are handled: Chrome's
// beforeinstallprompt heuristics still look for one, and the app's install
// button depends on that event.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  event.respondWith(
    fetch(req).catch(async () => {
      const cached = await caches.match(OFFLINE_URL);
      return cached || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    })
  );
});
