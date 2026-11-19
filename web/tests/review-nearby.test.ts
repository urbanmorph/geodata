import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as hyparquet from 'hyparquet';
import { nearby, nearestRows } from '../functions/lib/nearby';
import { clearHeadCache, clearMetadataCache } from '../functions/lib/parquet-r2';
import { fakeR2 } from './helpers/fake-r2';

vi.mock('hyparquet', async (importOriginal) => {
  const m = await importOriginal<typeof import('hyparquet')>();
  return { ...m, parquetReadObjects: vi.fn(m.parquetReadObjects), parquetMetadataAsync: vi.fn(m.parquetMetadataAsync) };
});
beforeEach(() => {
  vi.mocked(hyparquet.parquetReadObjects).mockClear();
  vi.mocked(hyparquet.parquetMetadataAsync).mockClear();
  clearHeadCache();
  clearMetadataCache();
});

describe('nearby scan path (no bbox columns)', () => {
  // 600 rows: id + WKB geometry, no xmin..ymax (parquet-column-stream fixture).
  const buf = readFileSync(new URL('./fixtures/wkb-pages-v1-zstd.parquet', import.meta.url));
  const catalog = { layers: [{ id: 'scan', level: 'x', source: 's', rows: 600, category: 'c', provenance: 'p',
    parquet: { url: 'https://r2.example/scan.parquet', bytes: buf.byteLength } }] } as never;

  it('parses the footer once (the cached one), not again for the scan', async () => {
    const gets: Array<[string, number, number]> = [];
    const r = await nearby(0.5, 0, 50, 'scan', catalog, fakeR2({ 'scan.parquet': buf }, gets), 5);
    expect(r._source).toBe('parquet-scan');
    expect(r.rows_scanned).toBe(600);
    expect(r.features.map((f) => f.properties)).toEqual([{ id: 0 }]); // row 0: (0,0)-(0,1)
    const footerReads = gets.filter(([, , end]) => end === buf.byteLength);
    expect(footerReads).toHaveLength(1);
  });
});

describe('nearby pass 2 reads winners in windows', () => {
  // nearby-rg: row i at (77 + i*0.0001, 12.9); 4 row groups of 2048.
  const buf = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
  const file = {
    byteLength: buf.byteLength,
    slice: async (s: number, e?: number) => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + (e ?? buf.byteLength)) as ArrayBuffer,
  };
  it('winners far apart in one row group are read as separate windows', async () => {
    const md = await hyparquet.parquetMetadataAsync(file);
    vi.mocked(hyparquet.parquetReadObjects).mockClear();
    // 10 km radius around row 1000: the 1,500 nearest span about rows 250..1750.
    const r = await nearestRows(file, md, ['id', 'names', 'geometry', 'xmin', 'ymin', 'xmax', 'ymax'], 'geometry', 12.9, 77.1, 10, 1500);
    expect(r.winners).toHaveLength(1500);
    const pass2 = vi.mocked(hyparquet.parquetReadObjects).mock.calls.map(([o]) => o).filter((o) => o.columns?.includes('names'));
    expect(pass2.length).toBeGreaterThan(1);
    for (const o of pass2) expect((o.rowEnd ?? 0) - (o.rowStart ?? 0)).toBeLessThanOrEqual(1000);
  });
});
