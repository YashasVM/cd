const CACHE_NAME = 'cd-shell-v3';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('cd-shell-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  const navigation = request.mode === 'navigate';
  const immutable = url.pathname.startsWith('/assets/');
  if (!navigation && !immutable && !['script', 'style', 'image', 'font'].includes(request.destination)) return;

  const key = navigation ? '/index.html' : request;
  const response = (async () => {
    const cache = await caches.open(CACHE_NAME);
    if (immutable) {
      const cached = await cache.match(key);
      if (cached) return cached;
    }
    try {
      const fresh = await fetch(request);
      if (fresh.ok) await cache.put(key, fresh.clone()).catch(() => {});
      return fresh;
    } catch {
      return await cache.match(key) || Response.error();
    }
  })();
  event.respondWith(response);
  event.waitUntil(response.then(() => {}));
});
