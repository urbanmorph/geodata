// bharatlas's offline worker. Its maps and datasets load from the internet (R2 and
// Cloudflare), so this is not an offline app. The worker exists only so
// that opening the site with no connection shows the site's own page saying so
// (offline/index.html), not the browser's error. It caches that one page and answers only a
// page load that fails; everything else goes to the network untouched, so nothing can
// go stale. Navigation preload lets the browser request the page while this worker
// starts, so the worker adds no delay to a page load. VERSION is the offline page's
// content hash (tests/offline.test.ts), so changing that page ships a new worker.
const VERSION = '81a7678cd227';
const CACHE = `offline-${VERSION}`;
const OFFLINE = '/offline/';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(new Request(OFFLINE, { cache: 'reload' }))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.navigationPreload?.enable();
      for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  event.respondWith(
    (async () => {
      try {
        return (await event.preloadResponse) || (await fetch(request));
      } catch {
        const page = await caches.match(OFFLINE, { cacheName: CACHE });
        return page ? new Response(page.body, { status: 503, headers: page.headers }) : Response.error();
      }
    })(),
  );
});
