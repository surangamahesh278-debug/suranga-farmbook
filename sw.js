const CACHE_NAME = 'suranga-farmbook-v19';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './sync.js',
  './supabase-config.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

const appUrl = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_FILES.map(appUrl));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith('suranga-farmbook-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin || requestUrl.href === appUrl('./sw.js')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      if (request.mode === 'navigate') {
        return (await cache.match(appUrl('./index.html'))) || Response.error();
      }
      return Response.error();
    }
  })());
});
