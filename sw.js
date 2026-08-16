const CACHE_NAME = 'podcast-app-shell-v2';
const IMAGE_CACHE_NAME = 'podcast-app-images-v1';
const IMAGE_CACHE_MAX_ENTRIES = 150; // grosszügig für mehrere Podcasts x Episoden-Historie
const APP_SHELL = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];
// index.html bewusst NICHT im Cache-first-Set: die Seite ändert sich
// häufig (neue Podcasts, Bugfixes) und soll immer die neueste Version
// vom Server holen. Nur wirklich statische Dateien (Icons, Manifest)
// werden gecached.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const keep = [CACHE_NAME, IMAGE_CACHE_NAME];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-Grösse begrenzen: älteste Einträge zuerst raus (Cache API hat
// keine eingebaute Expiry, cache.keys() liefert Einfüge-Reihenfolge).
async function trimImageCache() {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const keys = await cache.keys();
  const excess = keys.length - IMAGE_CACHE_MAX_ENTRIES;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

// Icons/Manifest ändern sich praktisch nie -> cache-first ist hier sicher.
// index.html/Navigation dagegen: immer zuerst das Netz probieren (frischer
// Stand), nur bei fehlendem Netz auf die zuletzt gesehene Version zurückfallen.
// Alles andere (Feeds, Audiodateien, Apps-Script-Proxy) läuft ganz normal,
// ohne dass der Service Worker eingreift.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Podcast-/Episoden-Cover kommen von den Feed-Hosts (fremde Domains) und
  // ändern sich pro Episode praktisch nie -> cache-first, auch cross-origin.
  // Cross-origin ohne CORS liefert eine "opaque" Response - die lässt sich
  // trotzdem cachen und an ein <img> ausliefern, nur nicht auslesen.
  if (request.destination === 'image') {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        // request wird für fetch() gebraucht, response für die Auslieferung
        // ans <img> -> beide vorher klonen. Das Klonen der Response muss
        // SOFORT nach dem Erhalt passieren, bevor der Browser anfängt, den
        // zurückgegebenen Original-Body zum <img> zu streamen - sonst ist
        // er beim späteren cache.put() schon "already used".
        const requestForCache = request.clone();
        return fetch(request)
          .then((response) => {
            const responseForCache = response.clone();
            event.waitUntil(
              caches.open(IMAGE_CACHE_NAME)
                .then((cache) => cache.put(requestForCache, responseForCache))
                .then(trimImageCache)
            );
            return response;
          })
          .catch(() => cached);
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  const isStaticAsset = APP_SHELL.some((path) => url.pathname.endsWith(path.replace('./', '')));
  if (isStaticAsset) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  const isNavigationOrHtml = event.request.mode === 'navigate' || url.pathname.endsWith('index.html');
  if (isNavigationOrHtml) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
