import { describe, it, expect } from 'vitest';
import { countingBucket } from '../functions/lib/profile-endpoint';
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
