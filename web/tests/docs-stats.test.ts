import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs build helper, no type declarations
import { docsStats } from '../scripts/docs-stats.mjs';

const catalog = {
  layers: [
    { id: 'a', licence: 'CC0-1.0' },
    { id: 'b', licence: 'CC0-1.0' },
    { id: 'c', licence: 'ODbL-1.0' },
    { id: 'd', licence: 'GODL-India' },
    { id: 'e' },
  ],
  download_counts: { a: { '': { parquet: 10, geojson: 5 }, '29': { parquet: 2 } }, c: { '': { kml: 3 } } },
};

describe('docsStats', () => {
  it('counts the layers', () => {
    expect(docsStats(catalog).layers).toBe(5);
  });

  it('groups layers by licence, most used first, unknown last', () => {
    expect(docsStats(catalog).licences).toEqual([
      ['CC0-1.0', 2],
      ['GODL-India', 1],
      ['ODbL-1.0', 1],
      ['not stated', 1],
    ]);
  });

  it('prints the download total it is given (the home page’s live counts), not the catalog snapshot', () => {
    expect(docsStats(catalog, 21964).downloads).toBe(21964);
  });

  it('copes with a catalog that has no download counts', () => {
    expect(docsStats({ layers: [] })).toEqual({ layers: 0, licences: [], downloads: 0 });
  });
});
