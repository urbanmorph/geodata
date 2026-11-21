// Isolate-level caches must share only RESOLVED values across requests. On
// Workers, I/O started by a request is cancelled when that request ends, and a
// promise left behind never settles ("This promise was created by a request
// that has since ended"). A cache holding that promise made every later
// /api/v1/nearby call for the layer wait ~60 s, until the platform limit.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ResolvedCache, withTimeout } from '../functions/lib/isolate-cache';
import { cachedMetadata, clearMetadataCache, clearHeadCache, asyncBufferFromR2 } from '../functions/lib/parquet-r2';
import { pmtilesFor } from '../functions/lib/locate';
import { loadCatalog, __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { loadReleaseIndex, __resetReleaseIndexForTest } from '../functions/lib/releases';
import { fakeR2 } from './helpers/fake-r2';

const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** 'ok' | 'err' when `p` settles within `ms`, 'hung' when it doesn't. */
function settles(p: Promise<unknown>, ms = 300): Promise<'ok' | 'err' | 'hung'> {
  return Promise.race([
    p.then(() => 'ok' as const, () => 'err' as const),
    new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms)),
  ]);
}

describe('ResolvedCache', () => {
  it('a load that never settles (its request ended) does not block the next request', async () => {
    const c = new ResolvedCache<number>();
    void c.get('k', never, {});
    expect(await settles(c.get('k', async () => 7, {}))).toBe('ok');
    expect(await c.get('k', never, {})).toBe(7); // now resolved: shared
  });

  it('keeps a resolved value: later requests do not load again', async () => {
    const c = new ResolvedCache<string>();
    const load = vi.fn(async () => 'v');
    expect(await c.get('k', load, {})).toBe('v');
    expect(await c.get('k', load, {})).toBe('v');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not keep a rejection', async () => {
    const c = new ResolvedCache<string>();
    await expect(c.get('k', async () => { throw new Error('R2 down'); })).rejects.toThrow('R2 down');
    expect(await c.get('k', async () => 'v')).toBe('v');
  });

  it('shares an in-flight load within one request only', async () => {
    const c = new ResolvedCache<string>();
    const req = {};
    const load = vi.fn(async () => 'v');
    await Promise.all([c.get('k', load, req), c.get('k', load, req)]);
    expect(load).toHaveBeenCalledTimes(1);
    c.clear();
    await Promise.all([c.get('k', load, {}), c.get('k', load, {})]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('drops the least recently used value past its bound', async () => {
    const c = new ResolvedCache<string>(2);
    await c.get('a', async () => 'a');
    await c.get('b', async () => 'b');
    await c.get('a', never); // touch a
    await c.get('c', async () => 'c');
    const load = vi.fn(async () => 'b2');
    expect(await c.get('b', load)).toBe('b2');
    expect(await settles(c.get('a', never))).toBe('hung'); // a went when b came back
  });
});

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers());
  it('fails a stuck read with a clear error', async () => {
    vi.useFakeTimers();
    const p = withTimeout(never(), 20_000, 'R2 read k');
    vi.advanceTimersByTime(20_000);
    await expect(p).rejects.toThrow('R2 read k timed out after 20 s');
  });
  it('passes a value or error through', async () => {
    expect(await withTimeout(Promise.resolve(1), 10, 'x')).toBe(1);
    await expect(withTimeout(Promise.reject(new Error('boom')), 10, 'x')).rejects.toThrow('boom');
  });
});

describe('parquet footer cache (cachedMetadata)', () => {
  const buf = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
  const file = (slice: (s: number, e?: number) => Promise<ArrayBuffer>) =>
    ({ cacheKey: 'layer.parquet@1:e1', byteLength: buf.byteLength, slice });
  const real = async (s: number, e?: number) =>
    buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + (e ?? buf.byteLength)) as ArrayBuffer;
  beforeEach(() => clearMetadataCache());

  it('a footer read whose request ended does not hang the next request', async () => {
    void cachedMetadata(file(never));
    expect(await settles(cachedMetadata(file(real)))).toBe('ok');
  });
});

describe('R2 reads time out instead of hanging', () => {
  beforeEach(() => clearHeadCache());
  afterEach(() => vi.useRealTimers());
  it('a parquet range read that never answers fails after the read timeout', async () => {
    const r2 = { head: async () => ({ size: 10, etag: 'e' }), get: never } as unknown as R2Bucket;
    const f = await asyncBufferFromR2(r2, 'stuck.parquet');
    vi.useFakeTimers();
    const p = f.slice(0, 4);
    vi.advanceTimersByTime(20_000);
    await expect(p).rejects.toThrow(/stuck\.parquet.*timed out/);
  });
});

// A minimal PMTiles v3 archive: 127-byte header + an empty root directory.
function tinyPmtiles(maxZoom = 12): Buffer {
  const b = Buffer.alloc(128);
  b.write('PMTiles', 0, 'latin1');
  b.writeUInt8(3, 7);
  b.writeBigUInt64LE(127n, 8); // root dir offset
  b.writeBigUInt64LE(1n, 16); // root dir length (one varint: 0 entries)
  b.writeUInt8(1, 97); // internal compression: none
  b.writeUInt8(maxZoom, 101);
  return b;
}

describe('PMTiles readers (pmtilesFor)', () => {
  it('a header read whose request ended does not hang the next request', async () => {
    const key = 'stuck-then-ok.pmtiles';
    let first = true;
    const ok = fakeR2({ [key]: tinyPmtiles() });
    const r2 = { get: (k: string, o: unknown) => (first ? ((first = false), never()) : ok.get(k, o as never)) } as unknown as R2Bucket;
    void pmtilesFor(r2, key).getHeader();
    expect(await settles(pmtilesFor(r2, key).getHeader())).toBe('ok');
  });

  it('reuses a resolved header across requests: one R2 read', async () => {
    const key = 'reused.pmtiles';
    const gets: Array<[string, number, number]> = [];
    const r2 = fakeR2({ [key]: tinyPmtiles(9) }, gets);
    expect((await pmtilesFor(r2, key).getHeader()).maxZoom).toBe(9);
    expect((await pmtilesFor(r2, key).getHeader()).maxZoom).toBe(9);
    expect(gets).toHaveLength(1);
  });
});

describe('catalog and release index loads', () => {
  const ctx = (assets: (u: string) => Promise<Response>) =>
    ({ request: new Request('https://bharatlas.com/api/v1/nearby'), env: { ASSETS: { fetch: vi.fn(assets) } } });
  beforeEach(() => { __resetCatalogForTest(); __resetReleaseIndexForTest(); });

  it('a catalog load whose request ended does not hang the next request', async () => {
    void loadCatalog(ctx(never));
    const ok = ctx(async () => new Response(JSON.stringify({ layers: [] })));
    expect(await settles(loadCatalog(ok))).toBe('ok');
  });

  it('a release index load whose request ended does not hang the next request', async () => {
    void loadReleaseIndex(ctx(never));
    const ok = ctx(async () => new Response(JSON.stringify({ latest: {} })));
    expect(await settles(loadReleaseIndex(ok))).toBe('ok');
  });
});
