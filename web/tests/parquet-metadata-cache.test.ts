import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { cachedMetadata, clearMetadataCache } from '../functions/lib/parquet-r2';

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
