const CACHE_NAME = 'podcast-app-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

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

// Nur die App-Shell (HTML/Manifest/Icons) aus dem Cache bedienen.
// Alles andere (Feeds, Audiodateien, Apps-Script-Proxy) geht immer
// direkt ins Netz, damit Inhalte nie veraltet oder riesig gecached werden.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isAppShell = url.origin === self.location.origin &&
    APP_SHELL.some((path) => url.pathname.endsWith(path.replace('./', '')));

  if (!isAppShell) return; // Browser macht normalen Netzwerk-Request

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
