const CACHE = "informer-ui-4";
const base = new URL(self.registration.scope);
const shell = [
  "control.html",
  "control.css",
  "control.js",
  "themes.js",
  "screen.html",
  "screen.css",
  "screen.js",
  "date-format.js",
  "weather-visuals.js",
  "value-motion.js",
  "manifest.webmanifest",
  "pwa.js",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-180.png",
  ...["day", "dawn", "night"].flatMap((time) =>
    ["clear", "cloudy", "partly"].map(
      (weather) => `assets/backgrounds/${time}-${weather}.jpg`,
    ),
  ),
  ...["wind-direction", "humidity", "pressure", "wind"].map(
    (icon) => `assets/icons/${icon}.svg`,
  ),
].map((file) => new URL(file, base).href);
const staticUrls = new Set(shell);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(shell)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("informer-ui-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  url.search = "";
  url.hash = "";
  if (event.request.method !== "GET" || !staticUrls.has(url.href)) return;

  event.respondWith(
    (async () => {
      let response;
      try {
        response = await fetch(event.request);
      } catch (error) {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(url.href);
        if (cached) return cached;
        throw error;
      }
      if (response.ok) {
        // Cache failures must not replace a working network response.
        try {
          const cache = await caches.open(CACHE);
          await cache.put(url.href, response.clone());
        } catch {
          // Storage can be unavailable or full; online use still works.
        }
      }
      return response;
    })(),
  );
});
