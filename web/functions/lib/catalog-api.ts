import { fetchAsset, loadCatalogVersioned, type AssetCtx } from './catalog-loader';
import { cached, cacheKey, CACHE_CONTROL, EDGE_TTL } from './edge-cache';
import { json } from './http';
import { layerIsNonCommercial, NC_NOTICE } from '../../../shared/licences.mjs';
import { realmOf } from '../../../shared/realms.mjs';
export interface CatalogLayer {
  id: string;
  level: string;
  source: string;
  rows: number | null;
  parquet?: { url: string; bytes: number | null } | null;
  pmtiles?: { url: string; bytes: number | null } | null;
  geojson?: { url: string; bytes: number | null } | null;
  kml?: { url: string; bytes: number | null } | null;
  shapefile?: { url: string; bytes: number | null } | null;
  licence?: string;
  /** Set for terms that forbid commercial use but aren't a licence id (e.g. "no commercial purposes"). */
  non_commercial?: boolean;
  attribution?: { primary?: { name: string; url: string }; publisher?: { name: string; url: string } | null };
  category: string;
  provenance: string;
  notes?: string;
  tags?: string[];
  fetched_at?: string | null;
  /** Its dated releases, newest first (added by web/scripts/public-catalog.mjs from the release index). */
  versions?: LayerVersion[];
}

/** One dated release of a layer: cite it by its code, SHA-256 or w3id address. */
export interface LayerVersion {
  code: string;
  released: string;
  sha256: string;
  w3id: string;
  url: string;
}

export interface CatalogData {
  layers: CatalogLayer[];
  categories: Record<string, string>;
  levels: Record<string, { order: number; plural: string; path: string; category: string }>;
  level_meta: Record<string, { label: string; unit: string; description: string }>;
  level_order: string[];
  filter_stats?: Record<string, unknown>;
}

export interface LayerFilter {
  category?: string;
  /** below, ground or air (shared/realms.mjs). */
  realm?: string;
  level?: string;
  source?: string;
  q?: string;
}

export interface PaginationOpts {
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiLayer {
  id: string;
  level: string;
  source: string;
  category: string;
  /** below, ground or air: where the layer sits (shared/realms.mjs, as on /layers). */
  realm: string;
  rows: number | null;
  provenance: string;
  licence?: string;
  attribution?: CatalogLayer['attribution'];
  notes?: string;
  downloads: Record<string, { url: string; bytes: number | null }>;
  level_meta?: { label: string; unit: string; description: string };
  filter_stats?: unknown;
  non_commercial?: true;
  licence_notice?: string;
  versions?: LayerVersion[];
}

export function filterLayers(layers: CatalogLayer[], filter: LayerFilter): CatalogLayer[] {
  return layers.filter((l) => {
    if (filter.category && l.category !== filter.category) return false;
    if (filter.realm && realmOf(l) !== filter.realm) return false;
    if (filter.level && l.level !== filter.level) return false;
    if (filter.source && l.source !== filter.source) return false;
    if (filter.q) {
      const q = filter.q.toLowerCase();
      const tags = (l.tags || []).join(' ');
      const hay = `${l.id} ${l.source} ${l.notes || ''} ${l.category} ${l.level} ${tags}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function paginateResults<T>(items: T[], opts: PaginationOpts): PaginatedResult<T> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  return {
    data: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  };
}

const FORMATS = ['parquet', 'pmtiles', 'geojson', 'kml', 'shapefile'] as const;

/** Spread into every answer about a layer or its rows: a non-commercial layer says so, in a field and in words. */
export function ncFields(layer: Pick<CatalogLayer, 'licence' | 'non_commercial'>): { non_commercial?: true; licence_notice?: string } {
  return layerIsNonCommercial(layer) ? { non_commercial: true, licence_notice: NC_NOTICE } : {};
}

export function toApiLayer(layer: CatalogLayer, catalog: CatalogData, detail = false): ApiLayer {
  const downloads: Record<string, { url: string; bytes: number | null }> = {};
  for (const fmt of FORMATS) {
    const d = layer[fmt];
    if (d?.url) downloads[fmt] = { url: d.url, bytes: d.bytes ?? null };
  }
  const result: ApiLayer = {
    id: layer.id,
    level: layer.level,
    source: layer.source,
    category: layer.category,
    realm: realmOf(layer),
    rows: layer.rows,
    provenance: layer.provenance,
    licence: layer.licence,
    attribution: layer.attribution,
    notes: layer.notes,
    downloads,
    level_meta: catalog.level_meta?.[layer.id],
    ...ncFields(layer),
  };
  if (detail && catalog.filter_stats?.[layer.id]) {
    result.filter_stats = catalog.filter_stats[layer.id];
  }
  if (detail) result.versions = layer.versions ?? [];
  return result;
}

/** Layer detail: a layer over LARGE_FILTER_BYTES keeps its filter stats in
 *  /api-data/filter-stats/<id>.json, not in the catalog; add them from there. */
export async function attachFilterStats(ctx: AssetCtx, api: ApiLayer): Promise<ApiLayer> {
  if (api.filter_stats) return api;
  try {
    const r = await fetchAsset(ctx, `/api-data/filter-stats/${encodeURIComponent(api.id)}.json`);
    if (r.ok) return { ...api, filter_stats: await r.json() };
  } catch { /* no file: no stats */ }
  return api;
}

export function toApiCategory(catalog: CatalogData): Array<{ id: string; label: string; layer_count: number }> {
  const counts: Record<string, number> = {};
  for (const l of catalog.layers) counts[l.category] = (counts[l.category] || 0) + 1;
  return Object.entries(catalog.categories).map(([id, label]) => ({
    id,
    label,
    layer_count: counts[id] || 0,
  }));
}

export function toApiLevel(catalog: CatalogData): Array<{ id: string; order: number; plural: string; category: string }> {
  return Object.entries(catalog.levels)
    .map(([id, v]) => ({ id, order: v.order, plural: v.plural, category: v.category }))
    .sort((a, b) => a.order - b.order);
}

/** A GET handler answering { data: build(catalog) }, kept in the colo per deploy. */
export function catalogEndpoint(build: (catalog: CatalogData) => unknown): PagesFunction<{ ASSETS: Fetcher }> {
  return async (ctx) => {
    const { catalog, version } = await loadCatalogVersioned(ctx);
    return cached(ctx, cacheKey(version, new URL(ctx.request.url)), EDGE_TTL.catalog, async () =>
      json(200, { data: build(catalog) }, { 'cache-control': CACHE_CONTROL.catalog }));
  };
}
