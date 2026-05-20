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

export type Catalog = {
  layers?: Layer[];
  states?: Array<{ code: number; name: string }>;
  state_counts?: Record<string, Record<string, number>>;
  state_bounds?: Record<string, [number, number, number, number]>;
  extracts?: Record<string, Record<string, Record<string, { url: string; bytes: number }>>>;
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
