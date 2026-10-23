// The offline worker (src/sw/sw.js), run for real in a sandbox: an in-memory
// Cache Storage and a network the test switches on and off.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../src/sw/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://collect.bharatlas.com';
const APP_JS = '/assets/app-DJmT4Z1m.js';
const OLD_JS = '/assets/qrcode-C2_U8-rg.js';

const typed = (body: string, type: string) => new Response(body, { headers: { 'content-type': type } });
const html = (body: string) => typed(body, 'text/html; charset=utf-8');

// In a worker, a relative URL resolves against the worker's origin.
class WorkerRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
  }
}
type Handler = (event: any) => void;
type Stores = Map<string, Map<string, Response>>;

function makeWorker(version: string, assets: string[], stores: Stores = new Map()) {
  const keyOf = (r: Request | string) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;
  // `deploy` is what the server has; it can run ahead of what the worker saved.
  const state = { online: true, fetched: [] as string[], deploy: version };
  const site: Record<string, () => Response> = {
    '/': () => html(`landing ${version}`),
    '/c/': () => html(`app shell ${state.deploy}`),
    '/india-outline.geojson': () => typed(`{"v":"${version}"}`, 'application/geo+json'),
    [APP_JS]: () => typed('app();', 'application/javascript'),
    [OLD_JS]: () => typed('qr();', 'application/javascript'),
  };
  async function net(req: Request): Promise<Response> {
    state.fetched.push(new URL(req.url).pathname);
    if (!state.online) throw new TypeError('Failed to fetch');
    const u = new URL(req.url);
    const path = u.origin === ORIGIN ? (u.pathname.startsWith('/c/') ? '/c/' : u.pathname) : req.url;
    return site[path]?.() ?? new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  }
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (r: Request | string) => store.get(keyOf(r))?.clone(),
      put: async (r: Request | string, res: Response) => void store.set(keyOf(r), res.clone()),
      keys: async () => [...store.keys()].map((u) => new Request(u)),
    };
  };
  const caches = {
    open,
    has: async (name: string) => stores.has(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (r: Request | string, opts?: { cacheName?: string }) => {
      for (const n of opts?.cacheName ? [opts.cacheName] : [...stores.keys()]) {
        const hit = stores.get(n)?.get(keyOf(r));
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };
  const handlers: Record<string, Handler> = {};
  const self = {
    __PRECACHE__: { version, pages: ['/', '/c/'], files: ['/india-outline.geojson'], assets },
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Handler) => (handlers[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: { navigationPreload: { enable: async () => {} } },
  };
  runInNewContext(SOURCE, { self, caches, fetch: net, Request: WorkerRequest, Response, URL, Promise });

  async function lifecycle(type: 'install' | 'activate') {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  }
  /** Dispatches a fetch; the response, or null if the worker let it through. */
  async function request(url: string, init: RequestInit & { mode?: string } = {}): Promise<Response | null> {
    // Only a browser can make a navigate request, so the mode is set after.
    const { mode, ...rest } = init;
    const req = new Request(new URL(url, ORIGIN), rest);
    if (mode) Object.defineProperty(req, 'mode', { value: mode });
    const event = { responded: null as Promise<Response> | null };
    const waits: Promise<unknown>[] = [];
    handlers.fetch({
      request: req,
      preloadResponse: Promise.resolve(undefined),
      respondWith: (p: Promise<Response>) => (event.responded = p),
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    const res = event.responded ? await event.responded : null;
    await Promise.all(waits);
    return res;
  }
  const page = (path: string) => request(path, { mode: 'navigate' });
  return { state, stores, lifecycle, request, page };
}

const text = async (r: Promise<Response | null>) => (await r)!.text();

describe('collect offline worker', () => {
  let w: ReturnType<typeof makeWorker>;
  beforeEach(async () => {
    w = makeWorker('v1', [APP_JS, OLD_JS]);
    await w.lifecycle('install');
    await w.lifecycle('activate');
  });

  it('offline, every map link opens the saved app shell', async () => {
    w.state.online = false;
    expect(await text(w.page('/c/abc123'))).toBe('app shell v1');
    expect(await text(w.page('/c/abc123/admin'))).toBe('app shell v1');
    expect(await text(w.page('/c/abc123/r/rec456'))).toBe('app shell v1');
    expect(await text(w.page('/'))).toBe('landing v1');
  });

  it('online, pages come from the network, so a deploy shows at once', async () => {
    w.state.deploy = 'v2'; // deployed; this worker still holds v1's shell
    expect(await text(w.page('/c/abc123'))).toBe('app shell v2');
  });

  it('offline, an unknown page gets collect\'s own offline page (styled, with a way home), not an error page', async () => {
    w.state.online = false;
    const res = (await w.page('/nowhere'))!;
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toMatch(/<h1>You're offline<\/h1>/);
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toMatch(/<a [^>]*href="\/"/);
    expect(html).toMatch(/<a [^>]*href=""[^>]*>Try again/);
  });

  it('hashed app files come from the cache; a copy of the wrong type is refetched', async () => {
    w.state.fetched = [];
    expect(await text(w.request(APP_JS))).toBe('app();');
    expect(w.state.fetched).toEqual([]);
    w.stores.get('collect-v1')!.set(`${ORIGIN}${APP_JS}`, html('<!doctype html>'));
    expect(await text(w.request(APP_JS))).toBe('app();');
  });

  it('the India outline is fresh online and saved for offline', async () => {
    w.state.online = false;
    expect(await text(w.request('/india-outline.geojson'))).toBe('{"v":"v1"}');
  });

  it('never touches the API, Turnstile, map tiles or POSTs', async () => {
    expect(await w.request('/api/collect/v1/collections/abc123')).toBeNull();
    expect(await w.request('/api/collect/v1/collections/abc123/records', { method: 'POST', body: '{}' })).toBeNull();
    expect(await w.request('https://challenges.cloudflare.com/turnstile/v0/api.js')).toBeNull();
    expect(await w.request('https://tile.openstreetmap.org/4/11/7.png')).toBeNull();
    // A form posted as a page load: never answered, or saved, as the app shell.
    expect(await w.request('/c/abc123', { method: 'POST', body: 'x', mode: 'navigate' })).toBeNull();
  });

  it('after a deploy, a tab still on the old version can load its old files', async () => {
    const next = makeWorker('v2', [APP_JS], w.stores); // OLD_JS is gone from v2
    await next.lifecycle('install');
    await next.lifecycle('activate');
    next.state.online = true;
    next.state.fetched = [];
    expect(await text(next.request(OLD_JS))).toBe('qr();');
    expect(next.state.fetched).toEqual([]);
  });

  it('keeps only the current and previous versions', async () => {
    for (const v of ['v2', 'v3']) {
      const next = makeWorker(v, [APP_JS], w.stores);
      await next.lifecycle('install');
      await next.lifecycle('activate');
    }
    expect([...w.stores.keys()]).toEqual(['collect-v2', 'collect-v3']);
  });

  it('a deploy reuses unchanged app files instead of downloading them again', async () => {
    const next = makeWorker('v2', [APP_JS], w.stores);
    await next.lifecycle('install');
    expect(next.state.fetched).not.toContain(APP_JS);
    expect(await next.stores.get('collect-v2')!.get(`${ORIGIN}${APP_JS}`)!.text()).toBe('app();');
  });
});
