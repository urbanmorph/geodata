import { describe, it, expect } from 'vitest';
import { coloBucket, coloCache, coloOf, withColoReads } from '../functions/lib/colo-cache';
import { noteCall, timedCall } from '../functions/lib/api-calls';
import type { EdgeCache } from '../functions/lib/edge-cache';

// A point lookup on a fresh isolate re-read every layer's metadata from R2 (95 of
// its 127 reads) and re-decoded the bbox columns (most of its CPU); production
// spreads lookups over many short-lived isolates, so the isolate's own caches
// rarely helped. The colo's cache keeps them for every isolate in the data centre.

function memoryCache() {
  const store = new Map<string, Response>();
  const cache: EdgeCache = {
    async match(key) { return store.get(String(key))?.clone(); },
    async put(key, res) { store.set(String(key), res); },
  };
  return { cache, store };
}

function deferred() {
  const pending: Promise<unknown>[] = [];
  return { defer: (p: Promise<unknown>) => { pending.push(p); }, settle: () => Promise.all(pending), pending };
}

const bytes = (...xs: number[]) => new Uint8Array(xs).buffer;

describe('coloCache', () => {
  it('a miss is null; a put waits until the answer is out, then serves every later lookup', async () => {
    const { cache, store } = memoryCache();
    const d = deferred();
    const colo = coloCache(cache, d.defer);
    expect(await colo.get('a/b')).toBeNull();
    colo.put('a/b', bytes(1, 2, 3), { size: '9' }, 600);
    expect(store.size).toBe(0); // nothing competes with the lookup's own reads
    colo.startPuts();
    await d.settle();
    expect(store.size).toBe(1);
    const hit = await colo.get('a/b');
    expect(new Uint8Array(hit!.data)).toEqual(new Uint8Array([1, 2, 3]));
    expect(hit!.meta).toEqual({ size: '9' });
    expect(colo.hits()).toBe(1);
    // a put after startPuts (a layer still running past its budget) goes out at once
    colo.put('late', bytes(4), {}, 600);
    await d.settle();
    expect(store.size).toBe(2);
  });

  it('a lookup that does not answer in time, or fails, is a miss: the cache never holds the answer up', async () => {
    const hung: EdgeCache = { match: () => new Promise(() => {}), put: async () => {} };
    const t0 = Date.now();
    expect(await coloCache(hung, () => {}, { timeoutMs: 30 }).get('k')).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    const broken: EdgeCache = { match: async () => { throw new Error('down'); }, put: async () => { throw new Error('down'); } };
    const d = deferred();
    const colo = coloCache(broken, d.defer);
    expect(await colo.get('k')).toBeNull();
    colo.put('k', bytes(1), {}, 60);
    colo.startPuts();
    await expect(d.settle()).resolves.toBeDefined(); // a failed put is dropped quietly
  });

  it('without a cache (tests, local dev) it is a no-op', async () => {
    const colo = coloCache(null, () => {});
    colo.put('k', bytes(1), {}, 60);
    colo.startPuts();
    expect(await colo.get('k')).toBeNull();
  });
});

describe('coloBucket', () => {
  function r2() {
    const reads: string[] = [];
    const data = new Uint8Array(100).map((_, i) => i);
    const bucket = {
      async get(key: string, opts?: { range?: { offset?: number; length?: number; suffix?: number } }) {
        if (key.startsWith('missing')) return null;
        const r = opts?.range;
        const [s, e] = !r ? [0, 100] : r.suffix !== undefined ? [100 - r.suffix, 100] : [r.offset!, r.offset! + (r.length ?? 100 - r.offset!)];
        reads.push(`${key} ${s}-${e}`);
        const part = data.slice(s, e);
        return { key, size: 100, etag: 'e1', httpEtag: '"e1"', httpMetadata: {}, arrayBuffer: async () => part.buffer, body: new Response(part).body };
      },
      async head(key: string) { reads.push(`head ${key}`); return { key, size: 100, etag: 'e1' }; },
    } as unknown as R2Bucket;
    return { bucket, reads };
  }

  async function warm(keys: Array<[string, R2GetOptions]>) {
    const { cache } = memoryCache();
    const first = r2();
    const d = deferred();
    const colo = coloCache(cache, d.defer);
    const b1 = coloBucket(first.bucket, colo, 'v1');
    for (const [k, o] of keys) await (await b1.get(k, o) as R2ObjectBody).arrayBuffer();
    colo.startPuts();
    await d.settle();
    const second = r2();
    const colo2 = coloCache(cache, () => {});
    return { b2: coloBucket(second.bucket, colo2, 'v1'), reads: second.reads, colo2, cache };
  }

  it('a parquet footer read (the file tail), a tile archive read and a GeoTIFF read come from the colo next time', async () => {
    const { b2, reads, colo2 } = await warm([
      ['a/x.parquet', { range: { suffix: 10 } }],
      ['a/x.pmtiles', { range: { offset: 0, length: 16 } }],
      ['a/x.tif', { range: { offset: 20, length: 4 } }],
    ]);
    const tail = await b2.get('a/x.parquet', { range: { suffix: 10 } }) as R2ObjectBody;
    expect(tail.size).toBe(100); // openParquet learns the size and etag from the tail read
    expect(tail.etag).toBe('e1');
    expect(new Uint8Array(await tail.arrayBuffer())[0]).toBe(90);
    const tile = await b2.get('a/x.pmtiles', { range: { offset: 0, length: 16 } }) as R2ObjectBody;
    expect(new Uint8Array(await tile.arrayBuffer()).length).toBe(16);
    const tif = await b2.get('a/x.tif', { range: { offset: 20, length: 4 } }) as R2ObjectBody;
    expect([...new Uint8Array(await tif.arrayBuffer())]).toEqual([20, 21, 22, 23]);
    expect(reads).toEqual([]);
    expect(colo2.hits()).toBe(3);
  });

  it("the point index's field files (read as one range) come from the colo next time; other JSON does not", async () => {
    const { b2, reads, colo2 } = await warm([
      ['point-index/props/zz.1234abcd.json', { range: { offset: 0, length: 100 } }],
      ['other/x.json', { range: { offset: 0, length: 100 } }],
    ]);
    await b2.get('point-index/props/zz.1234abcd.json', { range: { offset: 0, length: 100 } });
    await b2.get('other/x.json', { range: { offset: 0, length: 100 } });
    expect(reads).toEqual(['other/x.json 0-100']);
    expect(colo2.hits()).toBe(1);
  });

  it('point-specific parquet rows, whole-object gets, heads and missing keys go to R2 every time', async () => {
    const { b2, reads } = await warm([
      ['a/x.parquet', { range: { offset: 0, length: 10 } }],
      ['a/x.pmtiles', {}],
    ]);
    await b2.get('a/x.parquet', { range: { offset: 0, length: 10 } });
    await b2.get('a/x.pmtiles');
    await b2.head('a/x.parquet');
    expect(await b2.get('missing.tif', { range: { offset: 0, length: 4 } })).toBeNull();
    expect(reads).toEqual(['a/x.parquet 0-10', 'a/x.pmtiles 0-100', 'head a/x.parquet']);
  });

  it('keys carry the deploy version: a new deploy never reads an older deploy\'s bytes', async () => {
    const { cache } = memoryCache();
    const first = r2();
    const d = deferred();
    const c1 = coloCache(cache, d.defer);
    await (await coloBucket(first.bucket, c1, 'v1').get('a/x.tif', { range: { offset: 0, length: 4 } }) as R2ObjectBody).arrayBuffer();
    c1.startPuts();
    await d.settle();
    const second = r2();
    await coloBucket(second.bucket, coloCache(cache, () => {}), 'v2').get('a/x.tif', { range: { offset: 0, length: 4 } });
    expect(second.reads).toEqual(['a/x.tif 0-4']);
  });

  it('carries the colo cache for readers below it (decoded bbox columns)', () => {
    const colo = coloCache(null, () => {});
    expect(coloOf(coloBucket(r2().bucket, colo, 'v1'))).toBe(colo);
    expect(coloOf(r2().bucket)).toBeUndefined();
  });
});

// Nearby, query, export and locate read R2 directly: a fresh isolate re-read every
// parquet footer and tile directory, and nearby re-decoded the bbox columns, on every
// edge-cache miss. Through the colo (as /ground and /surface read) a second isolate
// in the data centre gets them in milliseconds; the call's record (api-calls.ts) says
// how many reads it made and how many the colo answered.
describe('withColoReads', () => {
  it('reads through the colo and notes the reads and colo hits on the call', async () => {
    const { cache } = memoryCache();
    const d = deferred();
    let r2Gets = 0;
    const r2 = {
      get: async (key: string) => { r2Gets++; return { key, size: 10, etag: 'e1', arrayBuffer: async () => bytes(7, 8) }; },
    } as unknown as R2Bucket;
    const points: AnalyticsEngineDataPoint[] = [];
    const env = { R2: r2, API_CALLS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) } };
    const handler = timedCall(async (ctx: { request: Request; env: typeof env; waitUntil: (p: Promise<unknown>) => void }) => {
      noteCall(ctx.request, { subject: 'lgd_states' });
      const obj = await withColoReads(ctx, 'v1', (b) => b.get('t/a.parquet', { range: { suffix: 8 } }), cache);
      return new Response(String(obj?.size));
    });
    const call = () => handler({ request: new Request('https://bharatlas.com/api/v1/nearby'), env, waitUntil: d.defer });

    expect(await (await call()).text()).toBe('10');
    await d.settle();
    expect(await (await call()).text()).toBe('10');
    expect(r2Gets).toBe(1);                                         // the second isolate's footer came from the colo
    expect(points.map((p) => p.doubles!.slice(2, 4))).toEqual([[1, 0], [0, 1]]); // R2 reads, colo hits
  });
});
