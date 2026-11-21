// collect's offline worker: the landing page and the map app open with no signal.
// Same safety rules as chaalwise's and irrational's workers (after SaralCare's
// 10 June 2026 incident):
// - pages and loose files are fetched network-first, so a deploy shows at once
//   (on a stalled connection, the saved copy after a few seconds);
// - only content-hashed build files are served from the cache, and only a copy
//   whose content type fits the file (never an HTML error page for a script);
// - the API, Turnstile, map tiles and every POST go straight to the network
//   (points sent offline wait in the page's own queue, src/outbox.ts).
// Each version has its own cache, and the previous one is kept: Pages serves only
// the current deploy's files, so a tab still on the old version would otherwise
// fail to load a lazy chunk mid-capture. The build prepends `self.__PRECACHE__`.

const { version, pages, shell, files, assets } = self.__PRECACHE__;
const PREFIX = 'collect-';
const CURRENT = `${PREFIX}${version}`;

const isHashedAsset = (path) => /^\/assets\/[^/]+-[\w-]{8}\.(js|css)$/.test(path);
const TYPES = { js: /^(text|application)\/javascript\b/, css: /^text\/css\b/ };
const typeMatches = (path, type) => !!type && !!TYPES[path.split('.').pop()]?.test(type);
// Every /c/… map page opens the one saved app shell (precache.ts APP_SHELL).
const pageKey = (path) => (path.startsWith('/c/') ? shell : path);
// Bypass the HTTP cache, so precaching never stores a stale copy.
const fresh = (path) => new Request(path, { cache: 'reload' });

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CURRENT);
      try {
        for (const path of assets) {
          // Unchanged build files are copied from the last version, not downloaded again.
          const have = await caches.match(path);
          if (have && typeMatches(path, have.headers.get('content-type'))) await cache.put(path, have);
          else await put(cache, path);
        }
        for (const path of [...pages, ...files]) await put(cache, path);
      } catch (e) {
        // A failed install never activates, so nothing else would delete its cache.
        await caches.delete(CURRENT);
        throw e;
      }
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
// A plain worker script, so it carries copies of the tokens it needs
// (shared/tokens.mjs; web/tests/design-tokens.test.ts keeps them equal).
const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><title>You're offline · collect</title>
<style>:root{color-scheme:light dark;--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Inter", sans-serif;--fs-md: 16px;--fs-2xl: 24px;--radius-sm: 4px;--bg: #F3F6F1;--bg-elevated: #ffffff;--fg: #0B1B3F;--muted: #4B5563;--edge: #0B1B3F;--accent-fill: #F28C28;--on-accent-fill: #0B1B3F}
@media (prefers-color-scheme: dark){:root{--bg: #0a0a0a;--bg-elevated: #15151a;--fg: #ededed;--muted: #9ca3af;--edge: #C8D0E3}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:var(--fs-md)/1.55 var(--font-sans);
padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left))}
main{max-width:30rem;text-align:center}h1{font-size:var(--fs-2xl);margin:0 0 .5rem}p{color:var(--muted);margin:0 0 1.4rem}
a{display:inline-flex;align-items:center;min-height:44px;margin:.25rem;padding:0 1.1rem;border-radius:var(--radius-sm);border:1.5px solid var(--edge);background:var(--bg-elevated);color:var(--fg);text-decoration:none;font-weight:750}
a.go{background:var(--accent-fill);color:var(--on-accent-fill);box-shadow:3px 3px 0 var(--edge)}</style></head>
<body><main><h1>You're offline</h1>
<p>This page isn't saved on this phone. Maps you've opened before with a connection still work, and points you add are kept and sent when you're back online.</p>
<a class="go" href="">Try again</a><a href="/">Your maps</a></main></body></html>`;

// How long a page waits for the network before opening from the saved copy. On
// a weak signal a request can stall for tens of seconds without failing.
const NETWORK_WAIT_MS = 3500;
const SLOW = Symbol('slow');

const savedCopy = async (key) => (await caches.match(key, { cacheName: CURRENT })) ?? (await caches.match(key));

// Network first; the saved copy when there's no connection, or when the network
// is slower than NETWORK_WAIT_MS (the request carries on and refreshes the copy).
async function networkFirst(event, key) {
  const network = (async () => (await event.preloadResponse) ?? (await fetch(event.request)))();
  // A full disk only means this copy isn't saved.
  event.waitUntil(network.then((response) => {
    if (!response.ok) return undefined;
    const copy = response.clone();
    return caches.open(CURRENT).then((c) => c.put(key, copy));
  }).catch(() => {}));
  let timer;
  try {
    const first = await Promise.race([network, new Promise((r) => { timer = setTimeout(() => r(SLOW), NETWORK_WAIT_MS); })]);
    if (first !== SLOW) return first;
    return (await savedCopy(key)) ?? (await network);
  } catch {
    return (await savedCopy(key)) ?? new Response(OFFLINE_PAGE, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  } finally {
    clearTimeout(timer);
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
