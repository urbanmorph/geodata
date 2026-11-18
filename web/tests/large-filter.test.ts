// One rule for every layer (owner, 2026-11-18): a layer whose parquet is over
// LARGE_FILTER_BYTES is filtered and exported by the API; smaller ones keep the
// in-browser DuckDB path. Never a per-layer list.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LARGE_FILTER_BYTES, FILTER_EXPORT_MAX_ROWS, usesServerFilter } from '../../shared/large-load.mjs';
import { EXPORT_MAX_ROWS } from '../functions/lib/parquet-export';

const MB = 1024 * 1024;
const catalog = JSON.parse(readFileSync(new URL('../../catalog.json', import.meta.url), 'utf8')) as {
  layers: Array<{ id: string; parquet?: { bytes?: number } | null }>;
};
const byId = (id: string) => catalog.layers.find((l) => l.id === id)!;

describe('LARGE_FILTER_BYTES', () => {
  it('is 100 MB', () => {
    expect(LARGE_FILTER_BYTES).toBe(100 * MB);
  });
  it('splits on the parquet size only', () => {
    expect(usesServerFilter({ parquet: { url: 'x', bytes: 100 * MB + 1 } })).toBe(true);
    expect(usesServerFilter({ parquet: { url: 'x', bytes: 100 * MB } })).toBe(false);
    expect(usesServerFilter({ parquet: { url: 'x' } })).toBe(false); // size unknown: today's path
    expect(usesServerFilter({ parquet: null })).toBe(false);
  });
  it('the export cap is one number for the panel and the API', () => {
    expect(FILTER_EXPORT_MAX_ROWS).toBe(50_000);
    expect(EXPORT_MAX_ROWS).toBe(FILTER_EXPORT_MAX_ROWS);
  });
});

describe('which catalog layers go through the API', () => {
  it('the multi-GB layers and Overture places (455 MB) do', () => {
    for (const id of ['bhuvan_gw_prospects', 'bhuvan_land_degradation_1516', 'overture_places_india', 'lgd_villages']) {
      expect(usesServerFilter(byId(id)), id).toBe(true);
    }
  });
  it('mid-size layers (lineaments 29 MB, LGD districts 24 MB) keep the browser path', () => {
    for (const id of ['bhuvan_lineaments_50k', 'lgd_districts']) {
      expect(usesServerFilter(byId(id)), id).toBe(false);
    }
  });
  it('every layer over the threshold, and only those', () => {
    for (const l of catalog.layers) {
      const b = l.parquet?.bytes ?? 0;
      expect(usesServerFilter(l), l.id).toBe(b > LARGE_FILTER_BYTES);
    }
  });
});

describe('where the panel gets its columns', () => {
  it('baked stats first; the in-browser probe only for a small layer; never for a large one', async () => {
    const { columnStatsSource } = await import('../src/filter-schema');
    expect(columnStatsSource(true, true)).toBe('baked');
    expect(columnStatsSource(true, false)).toBe('baked');
    expect(columnStatsSource(false, false)).toBe('probe');
    expect(columnStatsSource(false, true)).toBe('none');
  });
  it('every layer over the threshold has baked stats, so its panel opens', () => {
    const stats = (catalog as unknown as { filter_stats?: Record<string, unknown> }).filter_stats ?? {};
    const missing = catalog.layers.filter((l) => usesServerFilter(l) && !stats[l.id]).map((l) => l.id);
    expect(missing).toEqual([]);
  });
});
