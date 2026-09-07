/* Service worker for the phone day view (static/day.html, served at /day).
 *
 * Two narrow jobs:
 *   1. Keep the app shell -- HTML, CSS, the ES modules and their imports -- in
 *      a cache, so opening the app with no connection shows the day view
 *      rather than the browser's offline error.
 *   2. Keep the LAST good GET /api/schedule/today response, so that offline
 *      view has real data (this morning's plan) to draw instead of nothing.
 *
 * It is deliberately NOT a general offline layer. Only /api/schedule/today is
 * cached; every other /api/ call, and every mutation, goes straight to the
 * network where static/schedule/offline-queue.js handles being offline by
 * queueing. Nothing cached here is ever a source of truth -- a cached payload
 * is a stale read, replaced the moment a real one arrives.
 *
 * Classic worker, no imports: ES-module service workers are still uneven on
 * iOS, which is the whole target here.
 *
 * Note: a service worker needs a secure context, so this only registers when
 * the app is reached over HTTPS (e.g. `tailscale serve`) or on localhost. Over
 * plain http://<mac>:5050 it silently does nothing and the app still works
 * online; the IndexedDB sync queue does not need it.
 */
const CACHE = "studio-day-v1";
const TODAY_URL = "/api/schedule/today";

// Enough to boot the page offline from a cold cache. The fetch handler also
// caches any same-origin static asset it sees at runtime, so this list only
// has to cover the first paint's module graph.
const SHELL = [
  "/day",
  "/style.css",
  "/drafting.css",
  "/theme.js",
  "/ui-effects.js",
  "/manifest.webmanifest",
  "/schedule/day-mobile.css",
  "/schedule/day-mobile.js",
  "/schedule/api-auth.js",
  "/schedule/offline-queue.js",
  "/schedule/day.js",
  "/schedule/calendar.js",
  "/schedule/task-panel.js",
  "/schedule/commitment-panel.js",
  "/schedule/key.js",
  "/schedule/recurrence.js",
  // The drafting language's typeface and the grounds/tone it paints with --
  // small (~300 KB total), and without them a cold offline open is unstyled.
  "/vendor/fonts/IBMPlexSansCondensed-Regular.ttf",
  "/vendor/fonts/IBMPlexSansCondensed-Medium.ttf",
  "/vendor/textures/paper-tooth.jpg",
  "/vendor/textures/plate-tooth.jpg",
  "/vendor/textures/graphite-tooth-light.png",
  "/vendor/textures/graphite-tooth-dark.png",
  "/vendor/textures/wash-bleed.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // mutations are never touched here

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A navigation (opening /day): network first so a woken Mac serves the
  // latest shell; the cached copy is the fallback for a sleeping one.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/day", copy));
          return res;
        })
        .catch(() => caches.match("/day").then((hit) => hit || caches.match(request))),
    );
    return;
  }

  // Today's data: network first, keep the last good copy, fall back to it.
  // offline-queue.js -- not this cache -- is what carries a change made
  // against a stale copy.
  if (url.pathname === TODAY_URL) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(TODAY_URL, copy));
          }
          return res;
        })
        .catch(() => caches.match(TODAY_URL).then((hit) => hit || Response.error())),
    );
    return;
  }

  // Any other /api/ GET: straight to the network, never cached. A task panel
  // opened with no connection simply won't fill -- the honest outcome.
  if (url.pathname.startsWith("/api/")) return;

  // Static assets: cache first (the app has no build step; files change
  // rarely), refreshed in the background when the network is there.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
