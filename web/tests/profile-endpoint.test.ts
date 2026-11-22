import { describe, it, expect } from 'vitest';
import { countingBucket, profileHandler } from '../functions/lib/profile-endpoint';
import { coloOf } from '../functions/lib/colo-cache';
import { pmtilesFor } from '../functions/lib/locate';
import { onRequestGet as ground } from '../functions/api/v1/ground';
import { onRequestGet as surface } from '../functions/api/v1/surface';

// Usage (plan F13): a call to a point lookup counts like a call that names a layer
// (countApiUse), under endpoint:ground or endpoint:surface; a 404 while the flag is
// off and a 400 for a bad point do not count, nor do crawlers.
describe('the point lookups count their calls', () => {
  const run = async (handler: typeof ground, url: string, env: Record<string, unknown>, ua = 'bharatlas-mcp/1.8.0') => {
    const batches: unknown[][][] = [];
    const DB = {
      prepare: () => ({ bind: (...args: unknown[]) => args }),
      batch: async (stmts: unknown[][]) => { batches.push(stmts); return []; },
    };
    const waits: Promise<unknown>[] = [];
    const ASSETS = { fetch: async () => new Response('nope', { status: 500 }) }; // no catalog: the answer is a 500
    await handler({
      request: new Request(url, { headers: { 'user-agent': ua } }),
      env: { DB, ASSETS, ...env }, params: {}, waitUntil: (p: Promise<unknown>) => waits.push(p),
    } as never);
    await Promise.all(waits);
    return batches.map((b) => b[0][0]);
  };
  for (const [name, handler] of [['ground', ground], ['surface', surface]] as const) {
    it(`/api/v1/${name}`, async () => {
      const ok = `https://bharatlas.com/api/v1/${name}?lat=28.5&lng=77.1`;
      expect(await run(handler, ok, { POINT_PROFILES: 'on' })).toEqual([`endpoint:${name}`]);
      expect(await run(handler, ok, {})).toEqual([]); // off: a 404
      expect(await run(handler, `https://bharatlas.com/api/v1/${name}?lat=99&lng=77.1`, { POINT_PROFILES: 'on' })).toEqual([]);
      expect(await run(handler, ok, { POINT_PROFILES: 'on' }, 'Googlebot/2.1')).toEqual([]);
    });
  }
});

// How many R2 reads one uncached answer took (the x-profile-reads header): every
// read waits for one of the Worker's six connections, so this is the number that
// sets the latency of a point profile.
describe('countingBucket', () => {
  it('counts gets and heads and passes everything through', async () => {
    const calls: string[] = [];
    const r2 = {
      get: async (k: string) => { calls.push(`get ${k}`); return { k }; },
      head: async (k: string) => { calls.push(`head ${k}`); return { size: 1 }; },
      list: async () => ({ objects: [] }),
    } as unknown as R2Bucket;
    const c = countingBucket(r2);
    expect(await c.bucket.get('a')).toEqual({ k: 'a' });
    await c.bucket.get('b', { range: { offset: 0, length: 1 } });
    await c.bucket.head('a');
    expect(await c.bucket.list()).toEqual({ objects: [] });
    expect(calls).toEqual(['get a', 'get b', 'head a']);
    expect(c.reads()).toBe(3);
  });
});

describe('a tile reader kept for the isolate', () => {
  it('reads through the bucket of the request asking now', async () => {
    const seen: string[] = [];
    const bucket = (name: string) => ({
      get: async () => { seen.push(name); return null; },
    }) as unknown as R2Bucket;
    const a = pmtilesFor(bucket('a'), 'k/reader-test.pmtiles');
    const b = pmtilesFor(bucket('b'), 'k/reader-test.pmtiles');
    expect(b).toBe(a);
    await b.getHeader().catch(() => {});
    expect(seen).toEqual(['b']);
  });
});

// A fresh isolate's lookup read every layer's metadata from R2 again; the colo's
// cache (colo-cache.ts) keeps it for every isolate in the data centre. The handler
// reads through it and sends its puts only once the answer is out.
describe('a point lookup reads through the colo cache', () => {
  it('shared reads come from the colo on the next call, puts wait for the answer, and a header counts the hits', async () => {
    const store = new Map<string, Response>();
    const g = globalThis as { caches?: unknown };
    const before = g.caches;
    g.caches = { default: { match: async (k: RequestInfo) => store.get(String(k))?.clone(), put: async (k: RequestInfo, r: Response) => { store.set(String(k), r); } } };
    try {
      const r2reads: string[] = [];
      const R2 = {
        get: async (key: string) => { r2reads.push(key); return { key, size: 8, etag: 'e', httpEtag: '"e"', httpMetadata: {}, arrayBuffer: async () => new ArrayBuffer(4) }; },
      };
      let storedWhileRunning = -1;
      const handler = profileHandler('surface', async (lat, lng, _c, r2) => {
        expect(coloOf(r2)).toBeDefined();
        await (await r2.get('a/dem.tif', { range: { offset: 0, length: 4 } }) as R2ObjectBody).arrayBuffer();
        storedWhileRunning = [...store.keys()].filter((k) => k.includes('__colo')).length;
        return { point: { lat, lng }, summary: '', disclaimer: '', sections: {}, unavailable: [], attribution: [], timing_ms: 0, layer_timing_ms: {} };
      }, 'v');
      const ASSETS = { fetch: async (u: string) => (u.endsWith('catalog.json') ? new Response('{"layers":[]}') : new Response('', { status: 404 })) };
      const call = async (lat: number) => {
        const waits: Promise<unknown>[] = [];
        const res = await handler({
          request: new Request(`https://bharatlas.com/api/v1/surface?lat=${lat}&lng=77.1`),
          env: { ASSETS, R2, POINT_PROFILES: 'on' }, params: {}, waitUntil: (p: Promise<unknown>) => waits.push(p),
        } as never);
        await Promise.all(waits);
        return res;
      };
      const first = await call(28.5);
      // where the time went (a 60 s wait outside the profile's own timing_ms was seen in production)
      expect(first.headers.get('server-timing')).toMatch(/^catalog;dur=\d+, lookup;dur=\d+, profile;dur=\d+$/);
      expect((await call(28.5)).headers.get('server-timing')).toMatch(/^catalog;dur=\d+, lookup;dur=\d+$/); // an edge cache hit
      expect(storedWhileRunning).toBe(0);
      expect(first.headers.get('x-profile-reads')).toBe('1');
      expect(first.headers.get('x-profile-colo-hits')).toBe('0');
      const second = await call(28.6); // another point: its answer is not kept, the tif read is
      expect(second.headers.get('x-profile-reads')).toBe('0');
      expect(second.headers.get('x-profile-colo-hits')).toBe('1');
      expect(r2reads).toEqual(['a/dem.tif']);
    } finally {
      g.caches = before;
    }
  });
});
