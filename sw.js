/* ────────────────────────────────────────────────────────────────
   sw.js — KILL SWITCH (self-destructing service worker)
   ----------------------------------------------------------------
   This REPLACES the previous service worker of the full app.
   When a device that still has the old service worker next checks
   for an update, the browser fetches THIS file (byte-different),
   installs it, and on activation it:
     1. deletes every cache,
     2. unregisters itself,
     3. reloads all open pages so they fetch fresh from the network.
   After this runs, the device has NO service worker and shows the
   current content at the URL (the citizen app). The citizen app does
   not register any service worker, so nothing comes back.
   ──────────────────────────────────────────────────────────────── */
self.addEventListener('install', function (event) {
  // Activate immediately, don't wait for old SW to be released
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      // 1) delete all caches
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (e) {}
    try {
      // 2) unregister this service worker
      await self.registration.unregister();
    } catch (e) {}
    // NOTE: we intentionally do NOT force-reload clients here. The full app
    // (aftepistasia.html) re-registers sw.js on every load, so a forced reload
    // would cause an endless reload loop. Without a reload, caches are cleared
    // and the SW is unregistered; the very next time the app is opened it loads
    // fresh from the network (the citizen app), which self-heals cleanly.
  })());
});

// While alive, never serve from cache — always pass through to the network
self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request).catch(function () {
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }));
});
