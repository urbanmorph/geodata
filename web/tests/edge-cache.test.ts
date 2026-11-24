import { describe, it, expect, vi } from 'vitest';
import { answerKey, cached, cacheKey, NO_STORE, type EdgeCache } from '../functions/lib/edge-cache';
import { ANSWER_V } from '../functions/lib/answer-versions';

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

  it("stores for its ttl plus as long again to serve stale, but gives clients the handler's cache-control", async () => {
    const { cache, store } = memoryCache();
    const c = ctxFor('https://bharatlas.com/x');
    await cached(c.ctx, 'k', 600, body('{}'), cache);
    await c.settle();
    expect(store.get('k')!.headers.get('cache-control')).toBe('public, max-age=1200');
    const hit = await cached(ctxFor('https://bharatlas.com/x').ctx, 'k', 600, body('{}'), cache);
    expect(hit.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('does not store an answer the handler marks partial (x-edge-no-store), and strips the mark', async () => {
    const { cache, store } = memoryCache();
    const c = ctxFor('https://bharatlas.com/api/v1/ground?lat=1&lng=2');
    const r = await cached(c.ctx, 'k', 600, body('{"unavailable":["x"]}', { [NO_STORE]: '1' }), cache);
    await c.settle();
    expect(r.status).toBe(200);
    expect(r.headers.has(NO_STORE)).toBe(false);
    expect(store.size).toBe(0);
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

  it('computes when the cache lookup hangs: a stuck lookup never holds the answer up', async () => {
    const hung: EdgeCache = { match: () => new Promise(() => {}), put: async () => {} };
    const c = ctxFor('https://bharatlas.com/x');
    const t0 = Date.now();
    const r = await cached(c.ctx, 'k', 600, body('{"a":2}'), hung, 30);
    expect(await r.text()).toBe('{"a":2}');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// Stale-while-revalidate over the Cache API (it ignores the header): an answer past its ttl
// is served at once, marked STALE, while a fresh one is computed in the background; so a
// popular answer never makes a caller wait for its recompute.
describe('cached: stale-while-revalidate', () => {
  const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms);
  it('past its ttl: served STALE, refreshed in the background, fresh next time', async () => {
    const { cache } = memoryCache();
    let n = 0;
    const compute = async () => new Response(String(++n), { headers: { 'cache-control': 'public, max-age=60' } });
    at(1_000_000);
    const a = ctxFor('https://bharatlas.com/x');
    await cached(a.ctx, 'k', 600, compute, cache); await a.settle();
    at(1_000_000 + 601_000);
    const b = ctxFor('https://bharatlas.com/x');
    const stale = await cached(b.ctx, 'k', 600, compute, cache);
    expect(await stale.text()).toBe('1');
    expect(stale.headers.get('x-edge-cache')).toBe('STALE');
    await b.settle();
    const c = ctxFor('https://bharatlas.com/x');
    const fresh = await cached(c.ctx, 'k', 600, compute, cache);
    expect(await fresh.text()).toBe('2');
    expect(fresh.headers.get('x-edge-cache')).toBe('HIT');
    vi.restoreAllMocks();
  });
  it('one background refresh per key at a time; a failed one keeps the stale answer', async () => {
    const { cache } = memoryCache();
    let calls = 0;
    let fail = false;
    const compute = async () => { calls++; return fail ? new Response('no', { status: 500 }) : new Response('ok'); };
    at(2_000_000);
    const a = ctxFor('https://bharatlas.com/x');
    await cached(a.ctx, 'k2', 600, compute, cache); await a.settle();
    at(2_000_000 + 700_000);
    fail = true;
    const b = ctxFor('https://bharatlas.com/x');
    const c = ctxFor('https://bharatlas.com/x');
    await Promise.all([cached(b.ctx, 'k2', 600, compute, cache), cached(c.ctx, 'k2', 600, compute, cache)]);
    await b.settle(); await c.settle();
    expect(calls).toBe(2); // the first compute, then one refresh for the two stale hits
    const d = ctxFor('https://bharatlas.com/x');
    expect(await (await cached(d.ctx, 'k2', 600, compute, cache)).text()).toBe('ok');
    vi.restoreAllMocks();
  });
});

// Answer keys outlive deploys: an endpoint's answer version (answer-versions.ts) and the data
// the answer read, never the build id. A code change that changes an answer bumps the version
// (golden-answers.test.ts fails until it does).
describe('answerKey', () => {
  it('endpoint and its answer version, the data identity, then the path and sorted query; same on every host', () => {
    const a = answerKey('query', 'L1', new URL('https://preview.pages.dev/api/v1/layers/x/query?b=2&a=1'));
    expect(a).toBe(`https://bharatlas.com/__cache/a/query.v${ANSWER_V.query}/L1/api/v1/layers/x/query?a=1&b=2`);
    expect(answerKey('query', 'L1', new URL('https://bharatlas.com/api/v1/layers/x/query?a=1&b=2'))).toBe(a);
    expect(answerKey('query', 'L2', new URL('https://bharatlas.com/api/v1/layers/x/query?a=1&b=2'))).not.toBe(a);
  });
});
