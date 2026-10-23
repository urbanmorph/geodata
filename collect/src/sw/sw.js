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

// collect's own page for an address that isn't saved here, in collect's colours
// (light and dark), with a way home and "Try again" (an empty link reloads it).
const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><title>You're offline · collect</title>
<style>:root{color-scheme:light dark;--bg:#fff;--ink:#111827;--muted:#4b5563;--accent:#4f46e5}
@media (prefers-color-scheme: dark){:root{--bg:#0b0b10;--ink:#f3f4f6;--muted:#9ca3af;--accent:#818cf8}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left))}
main{max-width:30rem;text-align:center}h1{font-size:1.6rem;margin:0 0 .5rem}p{color:var(--muted);margin:0 0 1.4rem}
a{display:inline-block;margin:.25rem;padding:.6rem 1.1rem;border-radius:999px;border:1px solid var(--accent);color:var(--accent);text-decoration:none;font-weight:600}
a.go{background:var(--accent);color:#fff}</style></head>
<body><main><h1>You're offline</h1>
<p>This page isn't saved on this phone. Maps you've opened before with a connection still work, and points you add are kept and sent when you're back online.</p>
<a class="go" href="">Try again</a><a href="/">Your maps</a></main></body></html>`;

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
    return cached ?? new Response(OFFLINE_PAGE, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
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
