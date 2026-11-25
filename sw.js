// Goleszan 19: offline schedule and guide; public announcements always use the network.
const CACHE_NAME = "goleszan19-shell-v13-11-0-f1-ui9";
const SHELL = [
  "./", "./index.html", "./favicon.svg", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./manifest.webmanifest",
  "./dyskusje/notifications.js?v=ui4", "./administracja/admin.js?v=f1", "./administracja/dyzury.js?v=ui8", "./administracja/announcements.js?v=f1", "./ogloszenia/content.js", "./pwa-install.js?v=ui8",
  "./dyskusje/dyskusje.css?v=ui9", "./dyskusje/config.js", "./dyskusje/dyskusje.js?v=ui9", "./dyskusje/private-chat.js?v=ui4",
  "./kalendarz/kalendarz.js?v=ui8", "./kalendarz/kalendarz.css?v=ui8-r2",
  "./poradnik/poradnik.css?v=ui8", "./poradnik/dane.js", "./poradnik/poradnik.js?v=ui8",
  "./poradnik/media/kabina-1.webp",
  "./poradnik/media/kabina-2.webp",
  "./poradnik/media/kabina-3.webp",
  "./poradnik/media/kabina-ikony.webp",
  "./poradnik/media/kabina-ikony-light.webp",
  "./poradnik/media/okap-1.webp",
  "./poradnik/media/okap-2.webp",
  "./poradnik/media/okap-3.webp",
  "./poradnik/media/okap-ikony.webp",
  "./poradnik/media/okap-ikony-light.webp",
  "./poradnik/media/podloga-1.webp",
  "./poradnik/media/podloga-2.webp",
  "./poradnik/media/podloga-3.webp",
  "./poradnik/media/podloga-ikony.webp",
  "./poradnik/media/podloga-ikony-light.webp",
  "./poradnik/media/powierzchnie-1.webp",
  "./poradnik/media/powierzchnie-2.webp",
  "./poradnik/media/powierzchnie-3.webp",
  "./poradnik/media/powierzchnie-ikony.webp",
  "./poradnik/media/powierzchnie-ikony-light.webp",
  "./poradnik/media/szafki-1.webp",
  "./poradnik/media/szafki-2.webp",
  "./poradnik/media/szafki-3.webp",
  "./poradnik/media/szafki-ikony.webp",
  "./poradnik/media/szafki-ikony-light.webp",
  "./poradnik/media/toaleta-1.webp",
  "./poradnik/media/toaleta-2.webp",
  "./poradnik/media/toaleta-3.webp",
  "./poradnik/media/toaleta-ikony.webp",
  "./poradnik/media/toaleta-ikony-light.webp",
  "./poradnik/media/urzadzenia-1.webp",
  "./poradnik/media/urzadzenia-2.webp",
  "./poradnik/media/urzadzenia-3.webp",
  "./poradnik/media/urzadzenia-ikony.webp",
  "./poradnik/media/urzadzenia-ikony-light.webp",
  "./poradnik/media/zlewozmywak-1.webp",
  "./poradnik/media/zlewozmywak-2.webp",
  "./poradnik/media/zlewozmywak-3.webp",
  "./poradnik/media/zlewozmywak-4.webp",
  "./poradnik/media/zlewozmywak-5.webp",
  "./poradnik/media/zlewozmywak-6.webp",
  "./poradnik/media/zlewozmywak-7.webp",
  "./poradnik/media/zlewozmywak-ikony.webp",
  "./poradnik/media/zlewozmywak-ikony-light.webp",
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: "reload" })))));
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

self.addEventListener("push", event => {
  let data;
  try { data = event.data?.json(); } catch { return; }
  if (!data || !/^[0-9]+$/.test(data.id) || !/^#(dyskusje(?:\/prywatne\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?|calendar-title|ogloszenie-.+)$/i.test(data.target)) return;
  const titles = { messages: "Nowa wiadomość", announcements: "Ważne ogłoszenie", duties: "Przypomnienie o sprzątaniu" };
  if (!Object.hasOwn(titles, data.category)) return;
  const message = data.category === "messages";
  const privateMessage = message && data.kind === "private";
  const preview = message && [1, 2, 3, 4].includes(data.room) &&
    typeof data.preview === "string" && data.preview.length <= 401 && data.preview.trim();
  const manualDuty = data.category === "duties" && data.kind === "manual_duty";
  const announcementTitle = data.category === "announcements" && notificationText(data.title);
  const title = privateMessage ? "Goleszan 19 · Nowa wiadomość prywatna" : message ? "Goleszan 19 · Nowa wiadomość" : (manualDuty && notificationText(data.title)) || announcementTitle || titles[data.category];
  const body = privateMessage ? ([1,2,3,4].includes(data.room) ? "Nowa wiadomość prywatna od pokoju nr " + data.room : "Nowa wiadomość prywatna") : message
    ? (preview ? "Pokój nr " + data.room + ": " + preview : "Otwórz Goleszan 19.")
    : notificationText(data.body) || (data.category === "duties"
      ? "Sprawdź harmonogram sprzątania."
      : "Otwórz ogłoszenie w Goleszan 19.");
  event.waitUntil(self.registration.showNotification(title, {
    body, tag: "g19-" + data.id, renotify: false,
    icon: new URL("icon-192.png", self.registration.scope).href,
    data: { target: data.target }
  }));
});

function notificationText(value) {
  return typeof value === "string" && value.length <= 401 ? value.trim() : "";
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const hash = event.notification.data?.target;
  if (!/^#(dyskusje(?:\/prywatne\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?|calendar-title|ogloszenie-.+)$/i.test(hash || "")) return;
  const target = new URL(self.registration.scope);
  target.hash = hash;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      const navigated = await existing.navigate(target.href);
      if (navigated) { await navigated.focus(); return; }
    }
    await self.clients.openWindow(target.href);
  })());
});
