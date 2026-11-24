// Overture nearby at central Pune still ran out of resources (1102) about one call in
// seven after #367: its 5 winners sat in two row groups, and both were decoded at once.
// A nested column is decoded for its whole row group (20,480 rows) to give one row, so
// two at once doubled the memory held. The winners' bytes are fetched together up front
// (coalesced), and decoding is single-threaded anyway: one window at a time costs no time.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

let inFlight = 0, peak = 0;
vi.mock('hyparquet', async (orig) => {
  const real = await orig<typeof import('hyparquet')>();
  return {
    ...real,
    parquetReadObjects: async (...a: Parameters<typeof real.parquetReadObjects>) => {
      inFlight++; peak = Math.max(peak, inFlight);
      try { return await real.parquetReadObjects(...a); } finally { inFlight--; }
    },
  };
});

const { readRowsAt } = await import('../functions/lib/nearby');
const { parquetMetadataAsync } = await import('hyparquet');

describe('readRowsAt', () => {
  it('decodes one window at a time, and gives every row asked for', async () => {
    const buf = readFileSync(new URL('./fixtures/nearby-lines.parquet', import.meta.url));
    const file = {
      byteLength: buf.byteLength,
      slice: async (s: number, e?: number) => { await new Promise((r) => setTimeout(r, 2)); return buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + (e ?? buf.byteLength)) as ArrayBuffer; },
    };
    const metadata = await parquetMetadataAsync(file);
    const n = Number(metadata.num_rows);
    const idx = [0, Math.floor(n / 2), n - 1];
    peak = 0;
    const rows = await readRowsAt(file, metadata, ['name'], idx, 1); // windows of one row: three windows
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual(idx);
    expect(peak).toBe(1);
  });
});
