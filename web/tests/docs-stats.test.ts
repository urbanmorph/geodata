import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — plain .mjs build helper, no type declarations
import { docsStats, layerTotal } from '../scripts/docs-stats.mjs';

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

// One layer total for every page (home, /layers, /docs, /mcp): each curated
// layer, alternates included, plus each accepted community submission. A
// submission baked into the catalog (provenance 'community', c_<id>) is the same
// layer as its submission, so it counts once.
describe('layerTotal', () => {
  const cat = {
    layers: [
      { id: 'lgd_blocks', provenance: 'curated' },
      { id: 'gb_adm4', provenance: 'curated' },
      { id: 'c_abc', provenance: 'community' },
    ],
  };

  it('counts curated layers plus community submissions, a baked one once', () => {
    expect(layerTotal(cat, [{ id: 'abc' }, { id: 'def' }])).toBe(4);
  });

  it('is what /docs prints', () => {
    expect(docsStats(cat, 0, [{ id: 'abc' }, { id: 'def' }]).layers).toBe(4);
  });

  it('agrees with the real catalog and the build: home, /layers and /docs show one number', () => {
    const real = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8'));
    const html = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
    const home = html('index.html').match(/(\d+) layers<\/span>/)?.[1];
    const layers = html('layers.html').match(/(\d+) layers · \d+ themes/)?.[1];
    const docs = html('docs.html').match(/Query (\d+) open layers/)?.[1];
    expect(home).toBeDefined();
    expect(layers).toBe(home);
    expect(docs).toBe(home);
    expect(Number(home)).toBeGreaterThanOrEqual(real.layers.filter((l: { provenance?: string }) => l.provenance !== 'community').length);
  });
});
