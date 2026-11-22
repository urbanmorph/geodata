import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs import resolves at test time, no type defs
import { bakedCounts, countFor, fetchLiveCounts, mostDownloaded } from '../scripts/download-counts.mjs';

// The home page baked a stale catalog snapshot (948) while D1 counted ~22k;
// crawlers and link previews only see the baked HTML.
const catalog = { download_counts: { lgd_states: { '': { parquet: 63, geojson: 22 } } } };
const live = { lgd_states: { parquet: 642, geojson: 2383 }, udise_schools: { kml: 4 }, _total: 3029 };

describe('download counts at build time', () => {
  it('prefers live counts per layer and format', () => {
    const c = bakedCounts(catalog, live);
    expect(countFor(c, 'lgd_states', 'parquet')).toBe(642);
    expect(countFor(c, 'udise_schools', 'kml')).toBe(4);
    expect(countFor(c, 'lgd_states', 'kml')).toBe(0);
  });

  it('falls back to the catalog snapshot when live counts are unavailable', () => {
    const c = bakedCounts(catalog, null);
    expect(countFor(c, 'lgd_states', 'parquet')).toBe(63);
    expect(c.total).toBe(85);
  });

  it('uses the live _total when present', () => {
    expect(bakedCounts(catalog, live).total).toBe(3029);
  });

  it('returns null (not a throw) when the fetch fails or answers badly', async () => {
    expect(await fetchLiveCounts('https://x', async () => { throw new Error('offline'); })).toBeNull();
    expect(await fetchLiveCounts('https://x', async () => new Response('nope', { status: 500 }))).toBeNull();
    expect(await fetchLiveCounts('https://x', async () => Response.json(live))).toEqual(live);
  });
});

describe('mostDownloaded', () => {
  const counts = { layers: { a: { geojson: 5, kml: 1 }, b: { parquet: 50 }, c: {}, d: { geojson: 9 } }, total: 65 };

  it('ranks layers by total downloads across formats, highest first', () => {
    expect(mostDownloaded(counts, 3)).toEqual(['b', 'd', 'a']);
  });

  it('skips layers with no downloads and ids the caller excludes', () => {
    expect(mostDownloaded(counts, 10, (id) => id !== 'b')).toEqual(['d', 'a']);
  });
});
