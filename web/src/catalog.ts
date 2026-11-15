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

/** Per-layer (or per-level) display metadata. Inlined in the page catalog so
 *  the viewer can resolve a friendly title without a network round-trip. The
 *  edge (functions/lib/view-dataset.ts) reads the same field for /view SEO. */
export type LevelMeta = {
  label?: string;
  seo_title?: string;
  unit?: string;
  description?: string;
  seo_description?: string;
};

export type Catalog = {
  layers?: Layer[];
  level_meta?: Record<string, LevelMeta>;
  states?: Array<{ code: number; name: string }>;
  state_counts?: Record<string, Record<string, number>>;
  state_bounds?: Record<string, [number, number, number, number]>;
  extracts?: Record<string, Record<string, Record<string, { url: string; bytes: number }>>>;
  filter_stats?: Record<string, LayerFilterStats>;
  generated?: string;
  attribution?: Record<string, unknown>;
};

let cache: Promise<Catalog> | null = null;

/**
 * The catalog (layers, level metadata, extracts, filter stats), fetched once
 * per page. Not inlined in the HTML: the home page would carry ~38 KB gzipped
 * that only the map uses. main.ts starts this fetch early (hover on a map link,
 * or a /view load) so it runs alongside the map chunk download.
 */
export function getCatalog(): Promise<Catalog> {
  if (!cache) {
    cache = fetch('/catalog.json').then((r) => {
      if (!r.ok) throw new Error(`catalog.json ${r.status}`);
      return r.json() as Promise<Catalog>;
    });
    cache.catch(() => { cache = null; }); // a failed fetch can be retried
  }
  return cache;
}
