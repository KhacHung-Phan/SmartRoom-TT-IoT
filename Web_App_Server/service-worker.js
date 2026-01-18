const CACHE_NAME = "smartroom-v1";
const OFFLINE_URL = "/offline.html";

const PRECACHE = [
  "/",
  "/index.html",
  "/login.html",
  "/dashboard.html",
  "/sensors.html",
  "/realtime.html",
  "/controls.html",
  "/user.html",
  "/support.html",

  "/style.css",
  "/common.js",
  "/mqtt-client.js",
  "/firebase-init.js",
  "/auth.js",
  "/dashboard.js",
  "/sensors.js",
  "/realtime.js",
  "/controls.js",
  "/login.js",
  "/user.js",

  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  OFFLINE_URL
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Chỉ cache nội dung cùng origin
  if (url.origin !== location.origin) return;

  // HTML navigation: network-first
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || caches.match(OFFLINE_URL);
      }
    })());
    return;
  }

  // Asset: cache-first
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;

    const fresh = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, fresh.clone());
    return fresh;
  })());
});
