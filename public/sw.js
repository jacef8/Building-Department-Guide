// Service worker for the Building Dept Assistant PWA.
// Network-first for pages/docs so a new Railway deploy is always picked up
// when online; falls back to cache when offline. API calls never cached.
// Bump CACHE on any change so browsers install a fresh worker and purge the old cache.
const CACHE = 'bda-v3';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                     // never touch POSTs (/api/ask, /api/parcel)
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;          // let API calls hit the network directly

  // For the app shell (navigations / HTML) bypass the HTTP cache entirely so a
  // new deploy is never masked by an intermediate cached copy.
  const isShell = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');

  e.respondWith(
    fetch(req, isShell ? { cache: 'no-store' } : {})
      .then((res) => {
        if (res && res.status === 200 && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
