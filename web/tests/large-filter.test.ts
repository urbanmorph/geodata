// One rule for every layer (owner, 2026-11-18): a layer whose parquet is over
// LARGE_FILTER_BYTES is filtered and exported by the API; smaller ones keep the
// in-browser DuckDB path. Never a per-layer list.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
  it('every layer over the threshold has a stats file, and none rides in the catalog every visitor loads', () => {
    const stats = (catalog as unknown as { filter_stats?: Record<string, unknown> }).filter_stats ?? {};
    const large = catalog.layers.filter((l) => usesServerFilter(l)).map((l) => l.id);
    expect(large.filter((id) => stats[id])).toEqual([]);
    const missing = large.filter((id) => !existsSync(new URL(`../public/api-data/filter-stats/${id}.json`, import.meta.url)));
    expect(missing).toEqual([]);
  });
  it('the catalog stays light: no layer carries more than 20 KB of stats in it', () => {
    const stats = (catalog as unknown as { filter_stats?: Record<string, unknown> }).filter_stats ?? {};
    for (const [id, v] of Object.entries(stats)) expect(JSON.stringify(v).length, id).toBeLessThan(20_000);
  });
});

describe('loadBakedStats: the panel reads stats from the catalog, else the layer\'s file', () => {
  const s = { row_count: 3, columns: [] };
  it('uses the catalog when it has them, without fetching', async () => {
    const { loadBakedStats } = await import('../src/filter-stats');
    const f = vi.fn();
    expect(await loadBakedStats('a', { filter_stats: { a: s } }, f)).toBe(s);
    expect(f).not.toHaveBeenCalled();
  });
  it('fetches /api-data/filter-stats/<id>.json otherwise; none when there is no file', async () => {
    const { loadBakedStats } = await import('../src/filter-stats');
    const ok = vi.fn(async () => new Response(JSON.stringify(s)));
    expect(await loadBakedStats('big', {}, ok)).toEqual(s);
    expect(ok).toHaveBeenCalledWith('/api-data/filter-stats/big.json');
    const missing = vi.fn(async () => new Response('', { status: 404 }));
    expect(await loadBakedStats('small', {}, missing)).toBeNull();
  });
});

describe('API layer detail keeps its filter_stats when they live in a file', () => {
  it('adds the file\'s stats when the catalog has none', async () => {
    const { attachFilterStats } = await import('../functions/lib/catalog-api');
    const s = { row_count: 3, columns: [] };
    const assets = { fetch: vi.fn(async (u: string) => (String(u).endsWith('/api-data/filter-stats/big.json')
      ? new Response(JSON.stringify(s)) : new Response('', { status: 404 }))) };
    const ctx = { request: new Request('https://bharatlas.com/api/v1/layers/big'), env: { ASSETS: assets } };
    const big = await attachFilterStats(ctx, { id: 'big' } as never);
    expect((big as { filter_stats?: unknown }).filter_stats).toEqual(s);
    const small = await attachFilterStats(ctx, { id: 'small' } as never);
    expect((small as { filter_stats?: unknown }).filter_stats).toBeUndefined();
    const kept = await attachFilterStats(ctx, { id: 'big', filter_stats: { row_count: 9 } } as never);
    expect((kept as { filter_stats: { row_count: number } }).filter_stats.row_count).toBe(9);
  });
});
