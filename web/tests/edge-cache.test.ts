import { describe, it, expect, vi } from 'vitest';
import { cached, cacheKey, type EdgeCache } from '../functions/lib/edge-cache';

/** An in-memory stand-in for caches.default (which vitest's node env lacks). */
function memoryCache() {
  const store = new Map<string, Response>();
  const cache: EdgeCache = {
    async match(key) { return store.get(key)?.clone(); },
    async put(key, res) { store.set(key, res); },
  };
  return { cache, store };
}

function ctxFor(url: string, headers: Record<string, string> = {}) {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { request: new Request(url, { headers }), waitUntil: (p: Promise<unknown>) => { pending.push(p); } },
    settle: () => Promise.all(pending),
  };
}

const body = (s: string, extra: Record<string, string> = {}) =>
  async () => new Response(s, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', ...extra } });

describe('cacheKey', () => {
  it('puts the version first and sorts the query, so a deploy or a reordered query needs no purge', () => {
    const a = cacheKey('abc123', new URL('https://preview.pages.dev/api/v1/layers?q=x&category=water'));
    const b = cacheKey('abc123', new URL('https://bharatlas.com/api/v1/layers?category=water&q=x'));
    expect(a).toBe('https://bharatlas.com/__cache/abc123/api/v1/layers?category=water&q=x');
    expect(b).toBe(a);
    expect(cacheKey('def456', new URL('https://bharatlas.com/api/v1/layers'))).toBe('https://bharatlas.com/__cache/def456/api/v1/layers');
  });

  it('can leave the query out (pages whose content never depends on it)', () => {
    expect(cacheKey('v1', new URL('https://bharatlas.com/view/a?utm=x'), { query: false })).toBe('https://bharatlas.com/__cache/v1/view/a');
  });
});

describe('cached', () => {
  it('computes on a miss, stores it, and serves the stored copy next time', async () => {
    const { cache, store } = memoryCache();
    const compute = vi.fn(body('{"n":1}'));
    const first = ctxFor('https://bharatlas.com/api/v1/layers');
    const r1 = await cached(first.ctx, 'k', 600, compute, cache);
    await first.settle();
    expect(await r1.text()).toBe('{"n":1}');
    expect(r1.headers.get('x-edge-cache')).toBe('MISS');
    expect(store.has('k')).toBe(true);

    const second = ctxFor('https://bharatlas.com/api/v1/layers');
    const r2 = await cached(second.ctx, 'k', 600, compute, cache);
    expect(await r2.text()).toBe('{"n":1}');
    expect(r2.headers.get('x-edge-cache')).toBe('HIT');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("stores for its own ttl but gives clients the handler's cache-control", async () => {
    const { cache, store } = memoryCache();
    const c = ctxFor('https://bharatlas.com/x');
    await cached(c.ctx, 'k', 600, body('{}'), cache);
    await c.settle();
    expect(store.get('k')!.headers.get('cache-control')).toBe('public, max-age=600');
    const hit = await cached(ctxFor('https://bharatlas.com/x').ctx, 'k', 600, body('{}'), cache);
    expect(hit.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('never stores an error', async () => {
    const { cache, store } = memoryCache();
    const c = ctxFor('https://bharatlas.com/x');
    const r = await cached(c.ctx, 'k', 600, async () => new Response('bad', { status: 400 }), cache);
    await c.settle();
    expect(r.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it('sets an ETag from the key and answers 304 to a matching If-None-Match, hit or miss', async () => {
    const { cache } = memoryCache();
    const c = ctxFor('https://bharatlas.com/x');
    const r = await cached(c.ctx, 'k', 600, body('{}'), cache);
    await c.settle();
    const etag = r.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-z]+"$/);
    const hit = await cached(ctxFor('https://bharatlas.com/x', { 'if-none-match': etag }).ctx, 'k', 600, body('{}'), cache);
    expect(hit.status).toBe(304);
    expect(hit.headers.get('etag')).toBe(etag);
    const miss = await cached(ctxFor('https://bharatlas.com/x', { 'if-none-match': etag }).ctx, 'k', 600, body('{}'), memoryCache().cache);
    expect(miss.status).toBe(304);
    // Another key's ETag differs.
    const other = await cached(ctxFor('https://bharatlas.com/y').ctx, 'k2', 600, body('{}'), memoryCache().cache);
    expect(other.headers.get('etag')).not.toBe(etag);
  });

  it("keeps a handler's own ETag (e.g. one that carries the R2 object's)", async () => {
    const r = await cached(ctxFor('https://bharatlas.com/x').ctx, 'k', 600, body('{}', { etag: '"v-r2abc"' }), memoryCache().cache);
    expect(r.headers.get('etag')).toBe('"v-r2abc"');
  });

  it('just computes when there is no cache (vitest, or a runtime without caches.default)', async () => {
    const r = await cached(ctxFor('https://bharatlas.com/x').ctx, 'k', 600, body('{"a":1}'), null);
    expect(await r.text()).toBe('{"a":1}');
  });

  it('computes when the cache throws', async () => {
    const broken: EdgeCache = { match: async () => { throw new Error('down'); }, put: async () => { throw new Error('down'); } };
    const c = ctxFor('https://bharatlas.com/x');
    const r = await cached(c.ctx, 'k', 600, body('{"a":1}'), broken);
    await c.settle();
    expect(await r.text()).toBe('{"a":1}');
  });
});
