import { SUBMISSION_ID } from './submissions-sql';

// Which download an R2 object key is, for the /api/dl counter: the catalog
// lists every curated file; per-state LGD extracts and the extra files of a
// baked community layer follow fixed key shapes (see classifyDownload).

/** Public base URL of the geodata-data R2 bucket: its custom domain (edge-cached, Smart
 *  Tiered Cache) since Nov 2026. The r2.dev address serves the same bucket; older links,
 *  release manifests and community files may still name it (r2KeyFromUrl reads either). */
export const R2_PUBLIC_BASE = 'https://data.bharatlas.com';

/** The R2 object key of a public file URL (everything after the host), or null. */
export function r2KeyFromUrl(url: string | null | undefined): string | null {
  const m = url?.match(/^https?:\/\/[^/]+\/(.+)$/);
  return m ? m[1] : null;
}

export type Classified = {
  layer_id: string;
  state_code: string;    // '' for pan-India / non-state slicing
  format: string;        // ext without the dot
};

// ---------------------------------------------------------------------------
// classifyDownload: the counter's answer. The catalog lists every download file
// with its layer and format, so a requested key is looked up there. Per-state
// extracts (extracts/<plural>/<NN>/<file>) and a baked community layer's other
// files (community/<id>/<file>) aren't listed, so their key shapes apply, but
// only for a real state code and a layer the catalog has: anything else
// (scanner probes, made-up paths) is not a download and makes no counter row.

type CatalogLike = { layers: ReadonlyArray<{ id: string }> };
const DOWNLOAD_FORMATS = ['parquet', 'geojson', 'kml', 'shapefile', 'pmtiles'] as const;
const EXTRA_FORMATS: Record<string, string> = { parquet: 'parquet', geojson: 'geojson', kml: 'kml', zip: 'shapefile', csv: 'csv' };
/** LGD state codes run 1 to 38 (two digits in extract keys). */
const MAX_STATE_CODE = 38;
const EXTRACT = /^extracts\/([a-z]+)\/(\d{2})\/[^/]+?\.(?:shp\.)?([a-z0-9]+)$/;
const COMMUNITY = /^community\/([^/]+)\/[^/]+?\.(?:shp\.)?([a-z0-9]+)$/;

type Index = { files: Map<string, Classified>; ids: Set<string> };
const byCatalog = new WeakMap<object, Index>();

function catalogIndex(catalog: CatalogLike): Index {
  let idx = byCatalog.get(catalog);
  if (idx) return idx;
  idx = { files: new Map(), ids: new Set() };
  for (const l of catalog.layers) {
    idx.ids.add(l.id);
    for (const format of DOWNLOAD_FORMATS) {
      const key = r2KeyFromUrl(((l as Record<string, unknown>)[format] as { url?: string } | null | undefined)?.url);
      if (key) idx.files.set(key, { layer_id: l.id, state_code: '', format });
    }
  }
  byCatalog.set(catalog, idx);
  return idx;
}

export function classifyDownload(key: string, catalog: CatalogLike): Classified | null {
  if (!key) return null;
  const idx = catalogIndex(catalog);
  const listed = idx.files.get(key);
  if (listed) return listed;

  const ex = EXTRACT.exec(key);
  if (ex) {
    const [, plural, code, ext] = ex;
    const n = Number(code);
    const layer_id = `lgd_${plural}`;
    const format = EXTRA_FORMATS[ext];
    return format && n >= 1 && n <= MAX_STATE_CODE && idx.ids.has(layer_id) ? { layer_id, state_code: code, format } : null;
  }
  const cm = COMMUNITY.exec(key);
  if (cm) {
    const layer_id = `c_${cm[1]}`;
    const format = EXTRA_FORMATS[cm[2]];
    return format && SUBMISSION_ID.test(cm[1]) && idx.ids.has(layer_id) ? { layer_id, state_code: '', format } : null;
  }
  return null;
}
