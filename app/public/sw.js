// Service worker: offline shell plus the Android share-target handoff.
//
// The share target is a POST, and a POST cannot be answered by loading the SPA
// directly with the payload attached. So the worker parks the form data in a
// cache, redirects to the app, and the page picks it up on load.

const CACHE = "syncdrop-shell-v2";
const SHARE_CACHE = "syncdrop-share";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== SHARE_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method === "POST" && url.searchParams.has("share-target")) {
    event.respondWith(
      (async () => {
        const form = await request.formData();
        const cache = await caches.open(SHARE_CACHE);
        await cache.put("/shared", new Response(form));
        return Response.redirect("./?share-target=1", 303);
      })()
    );
    return;
  }

  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // The API and the relay must never be served stale, and blob parts must never
  // be cached at all.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/blob/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && request.mode === "navigate") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) ?? (await caches.match("./index.html")))
  );
});
