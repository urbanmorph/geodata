import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cachedMetadata, clearMetadataCache, clearHeadCache, asyncBufferFromR2, METADATA_CACHE_MAX, openParquet, FOOTER_READ_BYTES } from '../functions/lib/parquet-r2';
import { GROUND_LAYERS } from '../functions/lib/ground';
import { SURFACE_LAYERS } from '../functions/lib/surface';

// Parsing the Overture footer (217 row groups) cost ~4 s per request on the
// live site; footers only change when a layer is rebaked (new key or etag).
const buf = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
function counted(cacheKey?: string) {
  const f = {
    cacheKey,
    reads: 0,
    byteLength: buf.byteLength,
    slice: async (start: number, end?: number) => {
      f.reads++;
      return buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + (end ?? buf.byteLength)) as ArrayBuffer;
    },
  };
  return f;
}

beforeEach(() => clearMetadataCache());

describe('cachedMetadata', () => {
  it('reads the footer once per cache key', async () => {
    const a = counted('layer.parquet@123:etag1');
    const m1 = await cachedMetadata(a);
    const b = counted('layer.parquet@123:etag1');
    const m2 = await cachedMetadata(b);
    expect(a.reads).toBeGreaterThan(0);
    expect(b.reads).toBe(0);
    expect(m2).toBe(m1);
    expect(m1.row_groups).toHaveLength(4);
  });

  it('re-reads when the object changed (new etag or key)', async () => {
    await cachedMetadata(counted('layer.parquet@123:etag1'));
    const changed = counted('layer.parquet@123:etag2');
    await cachedMetadata(changed);
    expect(changed.reads).toBeGreaterThan(0);
  });

  it('does not cache buffers without a key', async () => {
    await cachedMetadata(counted());
    const again = counted();
    await cachedMetadata(again);
    expect(again.reads).toBeGreaterThan(0);
  });

  it('does not keep a failed read', async () => {
    const bad = { ...counted('k'), slice: async () => { throw new Error('R2 down'); } };
    await expect(cachedMetadata(bad)).rejects.toThrow('R2 down');
    const ok = counted('k');
    await cachedMetadata(ok);
    expect(ok.reads).toBeGreaterThan(0);
  });
});

describe('asyncBufferFromR2: R2 head cached per isolate', () => {
  const r2 = (heads: { n: number }, found = true) => ({
    async head() { heads.n++; return found ? { size: 10, etag: 'e1' } : null; },
    async get() { return null; },
  });
  beforeEach(() => clearHeadCache());
  afterEach(() => vi.useRealTimers());

  it('heads a key once for a few minutes, then again', async () => {
    vi.useFakeTimers();
    const heads = { n: 0 };
    const a = await asyncBufferFromR2(r2(heads) as never, 'k.parquet');
    await asyncBufferFromR2(r2(heads) as never, 'k.parquet');
    expect(heads.n).toBe(1);
    expect(a.byteLength).toBe(10);
    expect(a.etag).toBe('e1');
    vi.advanceTimersByTime(6 * 60_000);
    await asyncBufferFromR2(r2(heads) as never, 'k.parquet');
    expect(heads.n).toBe(2);
  });

  it('does not remember a missing key', async () => {
    const heads = { n: 0 };
    await expect(asyncBufferFromR2(r2(heads, false) as never, 'gone')).rejects.toThrow(/not found/);
    await expect(asyncBufferFromR2(r2(heads, false) as never, 'gone')).rejects.toThrow(/not found/);
    expect(heads.n).toBe(2);
  });
});

describe('openParquet: the footer read doubles as the head', () => {
  // A point profile opens ~30 parquet layers; with the head forgotten (after a
  // few minutes, or in a new isolate) each paid a head, then a footer read, one
  // after the other. The read of the file's tail also says its size and etag.
  const bucket = () => {
    const calls: string[] = [];
    const r2 = {
      async head() { calls.push('head'); return { size: buf.byteLength, etag: 'e9' }; },
      async get(_k: string, o: { range: { offset?: number; length?: number; suffix?: number } }) {
        const r = o.range;
        const start = r.suffix !== undefined ? Math.max(0, buf.byteLength - r.suffix) : r.offset!;
        const end = r.suffix !== undefined ? buf.byteLength : start + r.length!;
        calls.push(r.suffix !== undefined ? `tail ${r.suffix}` : `get ${start}-${end}`);
        return { size: buf.byteLength, etag: 'e9', arrayBuffer: async () => buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + end) };
      },
    };
    return { r2: r2 as unknown as R2Bucket, calls };
  };
  beforeEach(() => { clearHeadCache(); clearMetadataCache(); });

  it('one read, no head, for the size, etag and footer; then the head is remembered', async () => {
    const { r2, calls } = bucket();
    const { file, metadata } = await openParquet(r2, 'k.parquet');
    expect(calls).toEqual([`tail ${FOOTER_READ_BYTES}`]);
    expect(file.byteLength).toBe(buf.byteLength);
    expect(file.cacheKey).toBe(`k.parquet@${buf.byteLength}:e9`);
    expect(metadata.row_groups).toHaveLength(4);
    calls.length = 0;
    const again = await openParquet(r2, 'k.parquet');
    expect(calls).toEqual([]); // head and footer both kept
    expect(again.metadata).toBe(metadata);
  });

  it('slices outside the tail go to R2', async () => {
    const { r2, calls } = bucket();
    const { file } = await openParquet(r2, 'k2.parquet');
    calls.length = 0;
    const b = new Uint8Array(await file.slice(0, 4));
    expect(new TextDecoder().decode(b)).toBe('PAR1');
    expect(calls.length).toBeLessThanOrEqual(1);
  });

  it('a missing key is an error, not remembered', async () => {
    const r2 = { get: async () => null, head: async () => null } as unknown as R2Bucket;
    await expect(openParquet(r2, 'gone.parquet')).rejects.toThrow(/not found/);
  });
});

describe('the footer cache holds a point profile', () => {
  // /api/v1/ground and /api/v1/surface read about 30 parquet layers between them:
  // a cache of 16 footers was thrashed on every call, re-reading each one from R2.
  it('keeps every parquet footer the two profiles read, with room for the rest of the API', () => {
    const parquet = new Set([...GROUND_LAYERS, ...SURFACE_LAYERS]
      .filter((l) => l.match === 'nearest' && (!l.shape || l.shapeFrom === 'parquet')).map((l) => l.id));
    expect(parquet.size).toBeGreaterThan(25);
    expect(METADATA_CACHE_MAX).toBeGreaterThanOrEqual(parquet.size + 16);
  });
});
