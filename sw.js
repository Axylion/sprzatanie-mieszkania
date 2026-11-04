// Goleszan 19: minimal offline shell; public announcements always use the network.
const CACHE_NAME = "goleszan19-shell-v3";
const SHELL = ["./", "./index.html", "./favicon.svg", "./icon-192.png", "./icon-512.png", "./manifest.webmanifest"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("goleszan19-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // News should never be served from an old offline cache.
  if (url.pathname.endsWith("/announcements.json")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        // Keep the offline entry current after a successful online navigation.
        const response = await fetch(event.request, { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const path = url.pathname;
        const root = new URL("./", self.registration.scope).pathname;
        if (path === root || path === root + "index.html") {
          await cache.put("./index.html", response.clone());
        }
        return response;
      } catch (_) {
        return await cache.match("./index.html") || Response.error();
      }
    })());
    return;
  }
  if (!SHELL.some(path => new URL(path, self.registration.scope).pathname === url.pathname)) return;
  event.respondWith(caches.open(CACHE_NAME).then(cache =>
    cache.match(event.request).then(cached => cached || fetch(event.request))
  ));
});
