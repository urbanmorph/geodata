// collect's offline worker: the landing page and the map app open with no signal.
// Same safety rules as chaalwise's and irrational's workers (after SaralCare's
// 10 June 2026 incident):
// - pages and loose files are fetched network-first, so a deploy shows at once;
// - only content-hashed build files are served from the cache, and only a copy
//   whose content type fits the file (never an HTML error page for a script);
// - the API, Turnstile, map tiles and every POST go straight to the network
//   (points sent offline wait in the page's own queue, src/outbox.ts).
// Each version has its own cache, and the previous one is kept: Pages serves only
// the current deploy's files, so a tab still on the old version would otherwise
// fail to load a lazy chunk mid-capture. The build prepends `self.__PRECACHE__`.

const { version, pages, files, assets } = self.__PRECACHE__;
const PREFIX = 'collect-';
const CURRENT = `${PREFIX}${version}`;
const SHELL = '/c/'; // functions/c/[[path]].ts serves the app shell for every /c/… link

const isHashedAsset = (path) => /^\/assets\/[^/]+-[\w-]{8}\.(js|css)$/.test(path);
const TYPES = { js: /^(text|application)\/javascript\b/, css: /^text\/css\b/ };
const typeMatches = (path, type) => !!type && !!TYPES[path.split('.').pop()]?.test(type);
const pageKey = (path) => (path.startsWith('/c/') ? SHELL : path);
// Bypass the HTTP cache, so precaching never stores a stale copy.
const fresh = (path) => new Request(path, { cache: 'reload' });

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CURRENT);
      for (const path of assets) {
        // Unchanged build files are copied from the last version, not downloaded again.
        const have = await caches.match(path);
        if (have && typeMatches(path, have.headers.get('content-type'))) await cache.put(path, have);
        else await put(cache, path);
      }
      for (const path of [...pages, ...files]) await put(cache, path);
    })(),
  );
});

async function put(cache, path) {
  const response = await fetch(fresh(path));
  if (!response.ok) throw new TypeError(`precache ${path}: ${response.status}`);
  await cache.put(path, response);
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Keep this version and the one before it (caches.keys() is in creation order).
      const ours = (await caches.keys()).filter((k) => k.startsWith(PREFIX) && k !== CURRENT);
      await Promise.all(ours.slice(0, -1).map((k) => caches.delete(k)));
      // Start the page request while the worker boots, instead of after.
      await self.registration.navigationPreload?.enable();
      await self.clients.claim();
    })(),
  );
});

// Network first; the saved copy when there's no connection.
async function networkFirst(event, key) {
  try {
    const response = (await event.preloadResponse) ?? (await fetch(event.request));
    if (response.ok) {
      const copy = response.clone();
      // A full disk only means this copy isn't saved.
      event.waitUntil(caches.open(CURRENT).then((c) => c.put(key, copy)).catch(() => {}));
    }
    return response;
  } catch {
    const cached = (await caches.match(key, { cacheName: CURRENT })) ?? (await caches.match(key));
    return cached ?? new Response('You are offline, and this page is not saved on this device.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

async function asset(request, path) {
  const cached = await caches.match(path);
  if (cached && typeMatches(path, cached.headers.get('content-type'))) return cached;
  const response = await fetch(request, { cache: 'no-cache' });
  if (response.ok && typeMatches(path, response.headers.get('content-type'))) {
    await (await caches.open(CURRENT)).put(path, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (request.mode === 'navigate') event.respondWith(networkFirst(event, pageKey(path)));
  else if (isHashedAsset(path)) event.respondWith(asset(request, path));
  else if (files.includes(path)) event.respondWith(networkFirst(event, path));
  // Anything else, the API included, goes straight to the network, uncached.
});
