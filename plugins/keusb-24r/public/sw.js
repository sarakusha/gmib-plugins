const CACHE = "keusb-24r-ui-3";
const base = new URL(self.registration.scope);
const shell = [
  "control.html",
  "control.css",
  "control.js",
  "pwa.js",
  "icon.svg",
  "manifest.webmanifest",
].map((file) => new URL(file, base).href);
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(shell))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("keusb-24r-ui-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  url.search = "";
  url.hash = "";
  // Cache only the shell, never API responses, commands or authorization data.
  if (event.request.method !== "GET" || !shell.includes(url.href)) return;
  event.respondWith(
    (async () => {
      let response;
      try {
        response = await fetch(event.request);
      } catch (error) {
        const cached = await caches.match(url.href);
        if (cached) return cached;
        throw error;
      }
      if (response.ok) {
        try {
          await (await caches.open(CACHE)).put(url.href, response.clone());
        } catch {}
      }
      return response;
    })(),
  );
});
