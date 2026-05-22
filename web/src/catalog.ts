type Layer = {
  id: string;
  level: string;
  source: string;
  rows: number | null;
  parquet?: { url: string; bytes: number } | null;
  pmtiles?: { url: string; bytes: number } | null;
  geojson?: { url: string; bytes: number } | null;
  notes?: string;
  licence?: string;
  attribution?: { primary?: { name: string; url: string }; publisher?: { name: string; url: string } | null };
};

// v4.2: per-layer column statistics baked at build time (commit 3) so the
// FilterPanel can render its affordances with zero browser-side probe.
// External / community layers without baked stats fall back to live
// describeParquet via web/src/filter-probe.ts.
export type FilterStatsColumn = {
  name: string;
  type: 'string' | 'int' | 'float' | 'bool' | 'date' | 'geometry' | 'blob';
  distinct: number;
  null_frac: number;
  min?: string | number;
  max?: string | number;
  top_values?: Array<{ v: string | number; n: number }>;
};

export type LayerFilterStats = {
  row_count: number;
  columns: FilterStatsColumn[];
  // Pairs of columns that DuckDB detected as bijective at build time
  // (e.g. {state_lgd, stcode11, stname}). Only the canonical is shown
  // in the filter UI; the other members carry the same information and
  // would just confuse the user into ANDing them.
  column_groups?: Array<{ canonical: string; members: string[] }>;
};

export type Catalog = {
  layers?: Layer[];
  states?: Array<{ code: number; name: string }>;
  state_counts?: Record<string, Record<string, number>>;
  state_bounds?: Record<string, [number, number, number, number]>;
  extracts?: Record<string, Record<string, Record<string, { url: string; bytes: number }>>>;
  filter_stats?: Record<string, LayerFilterStats>;
  generated?: string;
  attribution?: Record<string, unknown>;
};

let inlineCache: Promise<Catalog> | null = null;
let fullCache: Promise<Catalog> | null = null;

/**
 * Small catalog — states, counts, bounds, layer metadata. Inlined in the
 * page by prerender, so this resolves with zero network for the common case.
 */
export function getCatalog(): Promise<Catalog> {
  if (inlineCache) return inlineCache;
  const inline = document.getElementById('catalog-data');
  if (inline?.textContent) {
    try {
      inlineCache = Promise.resolve(JSON.parse(inline.textContent) as Catalog);
      return inlineCache;
    } catch {
      /* fall through */
    }
  }
  inlineCache = fetch('/catalog.json').then((r) => r.json() as Promise<Catalog>);
  return inlineCache;
}

/** Full catalog including the extracts manifest. Lazy-fetched on first need. */
export function getFullCatalog(): Promise<Catalog> {
  if (fullCache) return fullCache;
  fullCache = fetch('/catalog.json').then((r) => r.json() as Promise<Catalog>);
  return fullCache;
}
