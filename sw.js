// Service worker: keeps a copy of the app on the phone so it opens offline.
// Strategy: show the cached copy immediately, refresh the cache in the background
// (so a new version appears on the next launch).
// The cache name comes from app-id and app-version in index.html (passed as sw.js?app=...&v=...).
// A new version = a new name = the phone drops the old copy and downloads everything fresh.
// Only caches starting with this app's id are ever deleted, so other apps on the same address are safe.

const params = new URL(self.location).searchParams;
const APP_ID = /^[a-z0-9-]{1,40}$/i.test(params.get('app') || '') ? params.get('app') : 'period-tracker';
const PREFIX = `${APP_ID}:`;
const CACHE = `${PREFIX}${params.get('v') || 'dev'}`;
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/config.js',
  './js/app.js',
  './js/dates.js',
  './js/predict.js',
  './js/storage.js',
  './js/calendar.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      // 'no-cache' = always check the server for a newer file (skips the browser's HTTP cache)
      const fresh = fetch(req, { cache: 'no-cache' })
        .then(async (res) => { if (res.ok) await cache.put(req, res.clone()); return res; })
        .catch(() => cached || Response.error());
      event.waitUntil(fresh.catch(() => {}));
      return cached || fresh;
    }),
  );
});
