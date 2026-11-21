import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { r2Tiff } from '../functions/lib/r2-tiff';

// In Workers a promise belongs to the request that made it: a pending read left in
// a shared cache by a request that ended never settles for the next request.
// So the cache holds parsed headers only, never a promise in flight.

const buf = readFileSync(new URL('./fixtures/tiff-pixel-cog.tif', import.meta.url));
function bucket() {
  let reads = 0;
  const r2 = {
    get: async (_k: string, o: { range: { offset: number; length: number } }) => {
      reads++;
      const b = buf.buffer.slice(buf.byteOffset + o.range.offset, buf.byteOffset + o.range.offset + o.range.length);
      return { arrayBuffer: async () => b };
    },
  } as unknown as R2Bucket;
  return { r2, reads: () => reads };
}

describe('r2Tiff', () => {
  it('reads the header for each request until one has parsed it, then never again', async () => {
    const b = bucket();
    const a1 = r2Tiff(b.r2, 'key-a');
    const a2 = r2Tiff(b.r2, 'key-a'); // asked while the first is in flight: its own read
    await Promise.all([a1.info, a2.info]);
    const afterTwo = b.reads();
    expect(afterTwo).toBeGreaterThanOrEqual(2);
    await r2Tiff(b.r2, 'key-a').info;
    expect(b.reads()).toBe(afterTwo);
  });

  it('does not keep a failed read', async () => {
    let fail = true;
    const r2 = { get: async () => { if (fail) throw new Error('down'); return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + 16384) }; } } as unknown as R2Bucket;
    await expect(r2Tiff(r2, 'key-b').info).rejects.toThrow('down');
    fail = false;
    await expect(r2Tiff(r2, 'key-b').info).resolves.toMatchObject({ samples: 3 });
  });
});
