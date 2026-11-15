// /api/v1/locate reads 13+ layers per request. One PMTiles reader per R2 key
// per isolate keeps each archive's header and directory cache warm instead of
// re-reading them from R2 on every request.
import { describe, it, expect } from 'vitest';
import { pmtilesFor } from '../functions/lib/locate';

describe('pmtilesFor', () => {
  it('reuses the reader for the same key and makes one per key', () => {
    const r2 = {} as never;
    const a = pmtilesFor(r2, 'wards/a.pmtiles');
    expect(pmtilesFor(r2, 'wards/a.pmtiles')).toBe(a);
    expect(pmtilesFor(r2, 'wards/b.pmtiles')).not.toBe(a);
  });
});
