/* ────────────────────────────────────────────────────────────────
   sw.js — RODIOS v9.12 cache/versioning
   ----------------------------------------------------------------
   - HTML/navigation requests: Network-First, fallback to last cached copy.
   - Static assets: Cache-First.
   - API calls and non-GET requests: never cached.
   This avoids stale HTML while still allowing the UI shell to open when the
   network is unavailable.
   ──────────────────────────────────────────────────────────────── */
const CACHE_VERSION = 'rodios-v9-13';
const STATIC_ASSETS = [
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => undefined))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => key !== CACHE_VERSION ? caches.delete(key) : undefined));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  // Αγνοούμε τα non-GET requests (π.χ. RPC calls, POST/PUT/DELETE προς API).
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Εξαιρούμε εντελώς API calls και third-party endpoints από το cache.
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('jsdelivr.net') ||
    url.hostname.includes('geoapify.com')
  ) {
    return;
  }

  // Ασφαλής ανάγνωση του accept header.
  const accept = event.request.headers.get('accept') || '';

  // Για HTML/navigation: NETWORK-FIRST για να μην μένουν παλιές εκδόσεις σε συσκευές.
  if (event.request.mode === 'navigate' || accept.includes('text/html')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const networkResponse = await fetch(event.request, { cache: 'no-store' });
        if (networkResponse && networkResponse.ok) {
          await cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) return cachedResponse;
        return new Response('Η εφαρμογή δεν είναι διαθέσιμη χωρίς σύνδεση και δεν υπάρχει αποθηκευμένη έκδοση.', {
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // Για στατικά assets: CACHE-FIRST με background update.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cachedResponse = await cache.match(event.request);
    if (cachedResponse) {
      fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.ok) cache.put(event.request, networkResponse.clone());
      }).catch(() => undefined);
      return cachedResponse;
    }
    const networkResponse = await fetch(event.request);
    if (networkResponse && networkResponse.ok) {
      await cache.put(event.request, networkResponse.clone());
    }
    return networkResponse;
  })());
});
