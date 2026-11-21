import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { chunkRanges, coalesced, mergeRanges } from '../functions/lib/parquet-coalesce';
import { nearby, nearestRows } from '../functions/lib/nearby';
import type { CatalogData } from '../functions/lib/catalog-api';
import { nearestByGeometry } from '../functions/lib/nearby-geometry';

// On Workers every R2 read waits for one of six connections, so a point profile
// that reads 30 layers paid for each column chunk separately (hyparquet fetches
// each requested column on its own). Ranges that sit next to each other in the
// file are read once.

const buf = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
function tracked() {
  const reads: Array<[number, number]> = [];
  return {
    reads,
    file: {
      byteLength: buf.byteLength,
      slice: async (s: number, e?: number) => {
        reads.push([s, e ?? buf.byteLength]);
        return buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + (e ?? buf.byteLength)) as ArrayBuffer;
      },
    },
  };
}

describe('mergeRanges', () => {
  it('joins ranges that touch or sit within the gap, sorted, and keeps far ones apart', () => {
    expect(mergeRanges([{ start: 100, end: 200 }, { start: 0, end: 100 }, { start: 250, end: 300 }, { start: 10_000, end: 10_100 }], 64, 1e9))
      .toEqual([{ start: 0, end: 300 }, { start: 10_000, end: 10_100 }]);
  });
  it('never grows a run past the size limit', () => {
    expect(mergeRanges([{ start: 0, end: 60 }, { start: 60, end: 120 }], 0, 100)).toEqual([{ start: 0, end: 60 }, { start: 60, end: 120 }]);
  });
  it('folds a range inside another', () => {
    expect(mergeRanges([{ start: 0, end: 100 }, { start: 10, end: 20 }], 0, 1e9)).toEqual([{ start: 0, end: 100 }]);
  });
});

describe('coalesced', () => {
  it('reads the four bbox columns of a row group once, and the rows are the same', async () => {
    const { file, reads } = tracked();
    const metadata = await parquetMetadataAsync(file);
    const columns = ['xmin', 'ymin', 'xmax', 'ymax'];
    reads.length = 0;
    const plain = await parquetReadObjects({ file, metadata, compressors, columns, rowStart: 0, rowEnd: 2048 });
    expect(reads.length).toBe(4); // hyparquet asks for each column chunk on its own
    reads.length = 0;
    const one = coalesced(file, chunkRanges(metadata, columns, 0, 2048));
    const rows = await parquetReadObjects({ file: one, metadata, compressors, columns, rowStart: 0, rowEnd: 2048 });
    expect(rows).toEqual(plain);
    expect(reads.length).toBe(1);
  });

  it('falls through to the file for a range it did not prefetch', async () => {
    const { file, reads } = tracked();
    const one = coalesced(file, [{ start: 0, end: 10 }]);
    reads.length = 0;
    const got = new Uint8Array(await one.slice(20, 30));
    expect([...got]).toEqual([...buf.subarray(20, 30)]);
    expect(reads).toEqual([[20, 30]]); // the prefetch was asked for when coalesced() was called
    expect([...new Uint8Array(await one.slice(2, 5))]).toEqual([...buf.subarray(2, 5)]);
    expect(reads).toEqual([[20, 30]]);
  });

  it('a failed prefetch is not an unhandled rejection; the slice that needs it fails', async () => {
    let n = 0;
    const bad = { byteLength: 100, slice: async () => { n++; throw new Error('R2 down'); } };
    const one = coalesced(bad, [{ start: 0, end: 50 }]);
    await expect(one.slice(0, 10)).rejects.toThrow('R2 down');
    expect(n).toBe(1);
  });
});

describe('the nearby engines read less, and answer the same', () => {
  it('nearestRows: one read per overlapping row group in pass 1', async () => {
    const { file, reads } = tracked();
    const md = await parquetMetadataAsync(file);
    reads.length = 0;
    const r = await nearestRows(file, md, ['id', 'names', 'geometry', 'xmin', 'ymin', 'xmax', 'ymax'], 'geometry', 12.9, 77.05, 50, 5);
    expect(r.winners[0].row.id).toBe('p500'); // the brute-force check is in nearby-twopass.test.ts
    expect(r.winners).toHaveLength(5);
    // 50 km overlaps row groups 0-2: at most 3 reads for pass 1 and 1 for pass 2
    expect(reads.length).toBeLessThanOrEqual(4);
  });

  it('nearby decodes only the columns asked for; [] decodes none and still counts', async () => {
    const { file, reads } = tracked();
    const r2 = {
      head: async () => ({ size: buf.byteLength, etag: 'cols' }),
      get: async (_k: string, o: { range: { offset: number; length: number } }) => ({ arrayBuffer: () => file.slice(o.range.offset, o.range.offset + o.range.length) }),
    } as unknown as R2Bucket;
    const catalog = { layers: [{ id: 'rg', parquet: { url: 'https://pub-x.r2.dev/t/rg-cols.parquet', bytes: buf.byteLength } }] } as unknown as CatalogData;
    const all = await nearby(12.9, 77.05, 5, 'rg', catalog, r2, 3);
    const some = await nearby(12.9, 77.05, 5, 'rg', catalog, r2, 3, ['id']);
    expect(some.features.map((f) => f.properties)).toEqual(all.features.map((f) => ({ id: f.properties.id })));
    expect(some.total).toBe(all.total);
    reads.length = 0;
    const none = await nearby(12.9, 77.05, 5, 'rg', catalog, r2, 1, []);
    expect(none.total).toBe(all.total);
    expect(none.features[0].properties).toEqual({});
    expect(reads.length).toBe(1); // the bbox columns only
  });

  it('nearestByGeometry: same answer as before', async () => {
    const lines = readFileSync(new URL('./fixtures/nearby-lines.parquet', import.meta.url));
    const file = { byteLength: lines.byteLength, slice: async (s: number, e?: number) => lines.buffer.slice(lines.byteOffset + s, lines.byteOffset + (e ?? lines.byteLength)) as ArrayBuffer };
    const md = await parquetMetadataAsync(file);
    const r = await nearestByGeometry(file, md, 28.5, 77.012, 5, { limit: 10 });
    expect(r.features.map((f) => f.properties.name)).toEqual(['short_near', 'long']);
  });
});
