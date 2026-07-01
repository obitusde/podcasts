const CACHE_NAME = 'podcast-app-shell-v2';
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
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Icons/Manifest ändern sich praktisch nie -> cache-first ist hier sicher.
// index.html/Navigation dagegen: immer zuerst das Netz probieren (frischer
// Stand), nur bei fehlendem Netz auf die zuletzt gesehene Version zurückfallen.
// Alles andere (Feeds, Audiodateien, Apps-Script-Proxy) läuft ganz normal,
// ohne dass der Service Worker eingreift.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
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
