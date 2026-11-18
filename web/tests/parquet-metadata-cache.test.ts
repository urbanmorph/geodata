import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cachedMetadata, clearMetadataCache, clearHeadCache, asyncBufferFromR2 } from '../functions/lib/parquet-r2';

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
