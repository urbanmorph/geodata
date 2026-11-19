// The filtered export reads a layer's WKB geometry only for the matching rows,
// streaming the page rather than decoding it whole (a DuckDB geometry page is
// up to ~100 MB; production Workers have 128 MB). Fixtures: make-wkb-pages.py.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { byteArrayColumnRows } from '../functions/lib/parquet-column-stream';
import type { AsyncBuffer } from '../functions/lib/parquet-r2';

function fixture(name: string, opts: { piece?: number } = {}) {
  const buf = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const reads: Array<[number, number]> = [];
  const file: AsyncBuffer = {
    byteLength: ab.byteLength,
    slice: async (s, e) => { reads.push([s, e ?? ab.byteLength]); return ab.slice(s, e); },
  };
  const streamed = { bytes: 0 };
  if (opts.piece) {
    const piece = opts.piece;
    file.stream = async function* (s, e) {
      for (let p = s; p < e; p += piece) {
        const out = new Uint8Array(ab.slice(p, Math.min(e, p + piece)));
        streamed.bytes += out.length;
        yield out;
      }
    };
  }
  return { file, metadata: parquetMetadata(ab, { geoparquet: false }), reads, streamed };
}

/** Row i: LINESTRING of (i % 40) + 2 points (i, k); every 7th row (i % 7 == 3) null where nullable. */
function expected(i: number, nullable: boolean): number[] | null {
  if (nullable && i % 7 === 3) return null;
  const n = (i % 40) + 2;
  return [n, ...Array.from({ length: n }, (_, k) => [i, k]).flat()];
}

function decodeLine(b: Uint8Array): number[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(v.getUint8(0)).toBe(1);
  expect(v.getUint32(1, true)).toBe(2);
  const n = v.getUint32(5, true);
  const out = [n];
  for (let k = 0; k < n * 2; k++) out.push(v.getFloat64(9 + 8 * k, true));
  return out;
}

async function rowsOf(f: ReturnType<typeof fixture>, group: number, rows: number[]) {
  const out: Array<number[] | null> = [];
  for await (const v of byteArrayColumnRows(f.file, f.metadata, group, 'geometry', rows, compressors)) {
    out.push(v === null ? null : decodeLine(v));
  }
  return out;
}

describe('byteArrayColumnRows', () => {
  const cases: Array<[string, boolean]> = [
    ['wkb-pages-v1-zstd.parquet', true],
    ['wkb-pages-v2-snappy.parquet', true],
    ['wkb-pages-v1-required.parquet', false],
  ];
  for (const [name, nullable] of cases) {
    it(`returns exactly the wanted rows, nulls included, across pages and groups (${name})`, async () => {
      const f = fixture(name);
      expect(f.metadata.row_groups.map((g) => Number(g.num_rows))).toEqual([250, 250, 100]);
      const g1 = [250, 251, 252, 253, 300, 387, 388, 499];
      expect(await rowsOf(f, 1, g1)).toEqual(g1.map((i) => expected(i, nullable)));
      expect(await rowsOf(f, 0, [3])).toEqual([expected(3, nullable)]);
      const all = Array.from({ length: 100 }, (_, i) => 500 + i);
      expect(await rowsOf(f, 2, all)).toEqual(all.map((i) => expected(i, nullable)));
    });
  }

  it('agrees with hyparquet on every row', async () => {
    const f = fixture('wkb-pages-v1-zstd.parquet');
    const ref = await parquetReadObjects({ file: f.file, metadata: f.metadata, compressors, columns: ['geometry'], rowStart: 250, rowEnd: 500, utf8: false }) as Array<{ geometry: Uint8Array | null }>;
    const rows = Array.from({ length: 250 }, (_, i) => 250 + i);
    const got: Array<Uint8Array | null> = [];
    for await (const v of byteArrayColumnRows(f.file, f.metadata, 1, 'geometry', rows, compressors)) got.push(v);
    const hex = (v: Uint8Array | null) => v && Buffer.from(v).toString('hex');
    expect(got.length).toBe(250);
    expect(got.map(hex).join(',') === ref.map((r) => hex(r.geometry)).join(',')).toBe(true);
  });

  it('values that straddle stream pieces come out whole (pieces of 7 bytes)', async () => {
    for (const name of ['wkb-pages-v1-zstd.parquet', 'wkb-pages-v2-snappy.parquet', 'wkb-pages-v1-required.parquet']) {
      const f = fixture(name, { piece: 7 });
      const nullable = !name.includes('required');
      const rows = [0, 3, 41, 42, 249];
      expect(await rowsOf(f, 0, rows)).toEqual(rows.map((i) => expected(i, nullable)));
    }
  });

  it('never fetches the body of a page without a wanted row, and stops after the last one', async () => {
    const f = fixture('wkb-pages-v1-required.parquet', { piece: 64 });
    const chunk = f.metadata.row_groups[0].columns[1].meta_data!;
    const chunkBytes = Number(chunk.total_compressed_size);
    expect(await rowsOf(f, 0, [200])).toEqual([expected(200, false)]); // a late page
    expect(f.streamed.bytes).toBeGreaterThan(0);
    expect(f.streamed.bytes).toBeLessThan(chunkBytes / 3);
    f.streamed.bytes = 0;
    expect(await rowsOf(f, 0, [0])).toEqual([expected(0, false)]); // the first row of the first page
    expect(f.streamed.bytes).toBeLessThan(1024); // stopped right after it
  });

  it('refuses a dictionary-encoded column instead of returning wrong bytes', async () => {
    const f = fixture('wkb-pages-dict.parquet');
    await expect(rowsOf(f, 0, [1])).rejects.toThrow(/dictionary/);
  });

  it('nothing wanted reads nothing', async () => {
    const f = fixture('wkb-pages-v1-zstd.parquet');
    expect(await rowsOf(f, 0, [])).toEqual([]);
    expect(f.reads).toEqual([]);
  });
});
