import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { query, QueryInputError } from '../functions/lib/parquet-query';

// `?geometry=true` is not an option, so it arrived as a where filter on the
// geometry column. Checking it read every polygon of lgd_blocks and the Worker
// hit its resource limit (503, error 1102; 2 Nov 2026). Refuse it up front.
const buf = readFileSync(new URL('./fixtures/nearby-rg.parquet', import.meta.url));
const file = {
  byteLength: buf.byteLength,
  slice: async (start: number, end?: number) =>
    buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + (end ?? buf.byteLength)) as ArrayBuffer,
};

describe('geometry column in where / group_by', () => {
  it('rejects a where filter on the geometry column with a 400-class error', async () => {
    await expect(query(file, { where: { geometry: 'true' } })).rejects.toThrow(QueryInputError);
  });

  it('points the caller to include_centroid', async () => {
    await expect(query(file, { where: { geometry: 'true' } })).rejects.toThrow(/include_centroid/);
  });

  it('rejects group_by on the geometry column', async () => {
    await expect(query(file, { groupBy: 'geometry' })).rejects.toThrow(QueryInputError);
  });
});
