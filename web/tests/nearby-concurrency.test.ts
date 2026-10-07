import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as hyparquet from 'hyparquet';
import { nearestRows } from '../functions/lib/nearby';

vi.mock('hyparquet', async (importOriginal) => {
  const m = await importOriginal<typeof import('hyparquet')>();
  return { ...m, parquetReadObjects: vi.fn(m.parquetReadObjects) };
});

const buf = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
const file = {
  byteLength: buf.byteLength,
  slice: async (s: number, e?: number) => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + (e ?? buf.byteLength)) as ArrayBuffer,
};

describe('nearby reads overlapping row groups in parallel', () => {
  it('overlaps pass-1 reads and still returns the nearest rows', async () => {
    const mock = vi.mocked(hyparquet.parquetReadObjects);
    const orig = mock.getMockImplementation()!;
    let inFlight = 0;
    let peak = 0;
    mock.mockImplementation(async (o) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try { return await orig(o); } finally { inFlight--; }
    });
    const md = await hyparquet.parquetMetadataAsync(file);
    // 50 km around row 500 overlaps row groups 0-2.
    const r = await nearestRows(file, md, ['id', 'names', 'geometry', 'xmin', 'ymin', 'xmax', 'ymax'], 'geometry', 12.9, 77.05, 50, 3);
    mock.mockImplementation(orig);
    expect(peak).toBe(3);
    expect(r.winners[0].row.id).toBe('p500');
    expect(r.rowsScanned).toBe(3 * 2048);
  });
});
