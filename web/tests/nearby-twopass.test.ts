import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { haversineKm, nearestRows, overlappingRowGroups, queryBbox } from '../functions/lib/nearby';

// Fixture (duckdb, 4 row groups x 2048 rows): row i is a point at
// (77 + i*0.0001, 12.9) with id 'p<i>', a nested names {primary: 'Place <i>'},
// WKB geometry and flat xmin/ymin/xmax/ymax.
// Overture places (4.4M rows, nested columns) hit Cloudflare 1102 because
// nearby decoded every column for every row in the overlapping row groups.
const buf = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
const COLS = ['id', 'names', 'geometry', 'xmin', 'ymin', 'xmax', 'ymax'];
const LAT = 12.9;
const LNG = 77.05; // row 500

function trackedFile() {
  const reads: Array<[number, number]> = [];
  const file = {
    byteLength: buf.byteLength,
    slice: async (start: number, end?: number) => {
      reads.push([start, end ?? buf.byteLength]);
      return buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + (end ?? buf.byteLength)) as ArrayBuffer;
    },
  };
  return { file, reads };
}

describe('two-pass nearby over parquet', () => {
  it('keeps only the row groups whose bbox statistics overlap the query', async () => {
    const { file } = trackedFile();
    const md = await parquetMetadataAsync(file);
    expect(overlappingRowGroups(md, queryBbox(LAT, LNG, 1))).toEqual([{ start: 0, end: 2048 }]);
    expect(overlappingRowGroups(md, queryBbox(LAT, 77.6, 1))).toEqual([{ start: 4096, end: 6144 }]);
  });

  it('returns exactly what a brute-force nearest search returns', async () => {
    const { file } = trackedFile();
    const md = await parquetMetadataAsync(file);
    const r = await nearestRows(file, md, COLS, 'geometry', LAT, LNG, 50, 5);

    const all = await parquetReadObjects({ file, metadata: md, compressors, columns: ['id', 'xmin', 'ymin', 'xmax', 'ymax'] });
    const within = all
      .map((row) => ({ id: row.id, d: haversineKm(LAT, LNG, (row.ymin + row.ymax) / 2, (row.xmin + row.xmax) / 2) }))
      .filter((x) => x.d <= 50)
      .sort((a, b) => a.d - b.d);
    expect(r.total).toBe(within.length);
    expect(r.winners.map((w) => w.row.id)).toEqual(within.slice(0, 5).map((x) => x.id));
    expect(r.winners[0].row.names).toEqual({ primary: 'Place 500' }); // full row came back
  });

  it('decodes nested columns only in the row groups that hold winners', async () => {
    const { file, reads } = trackedFile();
    const md = await parquetMetadataAsync(file);
    reads.length = 0;
    // 50 km overlaps row groups 0-2 in pass 1; the 5 nearest are all in group 0.
    await nearestRows(file, md, COLS, 'geometry', LAT, LNG, 50, 5);

    const namesChunk = (g: number) => {
      const col = md.row_groups[g].columns.find((c) => c.meta_data?.path_in_schema[0] === 'names')!.meta_data!;
      const start = Number(col.dictionary_page_offset ?? col.data_page_offset);
      return [start, start + Number(col.total_compressed_size)] as const;
    };
    const touched = (g: number) => reads.some(([s, e]) => s < namesChunk(g)[1] && e > namesChunk(g)[0]);
    expect(touched(0)).toBe(true);
    expect(touched(1)).toBe(false);
    expect(touched(2)).toBe(false);
  });
});

describe('row-group pruning only trusts float statistics', () => {
  // DECIMAL statistics are raw scaled integers (12.9 is stored as 129):
  // trusting them would skip every row group and silently return nothing.
  it('keeps row groups whose bbox columns are not DOUBLE/FLOAT', async () => {
    const b = readFileSync(new URL('./fixtures/nearby-decimal.parquet', import.meta.url));
    const file = { byteLength: b.byteLength, slice: async (s: number, e?: number) => b.buffer.slice(b.byteOffset + s, b.byteOffset + (e ?? b.byteLength)) as ArrayBuffer };
    const md = await parquetMetadataAsync(file);
    expect(overlappingRowGroups(md, queryBbox(LAT, LNG, 1))).toEqual([{ start: 0, end: 2048 }, { start: 2048, end: 4096 }]);
    const r = await nearestRows(file, md, ['id', 'geometry', 'xmin', 'ymin', 'xmax', 'ymax'], 'geometry', LAT, LNG, 1, 3);
    const ids = r.winners.map((w) => w.row.id);
    expect(ids[0]).toBe('p500');
    expect(ids.slice(1).sort()).toEqual(['p499', 'p501']); // equidistant: order is a tie
  });
});
