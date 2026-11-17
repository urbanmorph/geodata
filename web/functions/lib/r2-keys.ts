// Derive (layer_id, state_code, format) from an R2 object key.
// Used by /api/dl/[[path]] to bump the right download counter row.
//
// Key shapes we recognise:
//   admin/<level-plural>/<stem>.<ext>          curated pan-India (LGD/SOI/Bhuvan/PMGSY)
//   extracts/<level-plural>/<NN>/<file>.<ext>  pre-baked per-state extracts (LGD-derived)
//   community/<id>/<file>.<ext>                user submission (v3.1)
//   geoboundaries/IND_ADM<N>.geojson           cross-check layers
//   boundaries/<level-plural>/<stem>_<ab>.<ext>  legacy CG/JH/OD slices

/** Public base URL of the geodata-data R2 bucket. */
export const R2_PUBLIC_BASE = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev';

export type Classified = {
  layer_id: string;
  state_code: string;    // '' for pan-India / non-state slicing
  format: string;        // ext without the dot
};

const PLURAL_TO_LEVEL: Record<string, string> = {
  states: 'states',
  districts: 'districts',
  subdistricts: 'subdistricts',
  blocks: 'blocks',
  villages: 'villages',
};

function stemToLayerId(stem: string): string {
  // 'LGD_States' -> 'lgd_states'; 'PMGSY_Blocks' -> 'pmgsy_blocks'.
  return stem.toLowerCase();
}

export function classifyKey(key: string): Classified | null {
  if (!key || typeof key !== 'string') return null;

  // extracts/<plural>/<NN>/<file>.<ext>
  let m = key.match(/^extracts\/([a-z]+)\/(\d+)\/[^/]+\.([a-z0-9]+)$/);
  if (m) {
    const [, plural, code, ext] = m;
    if (!PLURAL_TO_LEVEL[plural]) return null;
    return { layer_id: `lgd_${plural}`, state_code: code, format: ext };
  }

  // community/<id>/<file>.<ext>
  m = key.match(/^community\/([A-Za-z0-9_-]+)\/[^/]+\.([a-z0-9]+)$/);
  if (m) {
    const [, id, ext] = m;
    return { layer_id: `c_${id}`, state_code: '', format: ext };
  }

  // admin/<plural>/<stem>.<ext>
  m = key.match(/^admin\/([a-z]+)\/([A-Za-z0-9_]+)\.([a-z0-9]+)$/);
  if (m) {
    const [, , stem, ext] = m;
    return { layer_id: stemToLayerId(stem), state_code: '', format: ext };
  }

  // geoboundaries/IND_ADM<N>.geojson
  m = key.match(/^geoboundaries\/IND_ADM(\d)\.([a-z0-9]+)$/);
  if (m) {
    const [, n, ext] = m;
    return { layer_id: `gb_adm${n}`, state_code: '', format: ext };
  }

  // boundaries/<plural>/<stem>_<state-abbr>.<ext>  (legacy CG/JH/OD)
  m = key.match(/^boundaries\/([a-z]+)\/([a-z_]+)_([a-z]{2,3})\.([a-z0-9]+)$/);
  if (m) {
    const [, plural, stem, abbr, ext] = m;
    return { layer_id: stem, state_code: abbr, format: ext };
  }

  return null;
}

// ---------------------------------------------------------------------------
// classifyDownload: the counter's answer. The catalog lists every download file
// with its layer and format, so a requested key is looked up there (classifyKey's
// key shapes recognised 40 of 522 files). Per-state extracts and community uploads
// aren't listed in the catalog, so their key shapes still apply. Anything else
// (scanner probes like .php, unknown files) is not a download and isn't counted.

type CatalogLike = { layers: Array<Record<string, unknown> & { id: string }> };
const DOWNLOAD_FORMATS = ['parquet', 'geojson', 'kml', 'shapefile', 'pmtiles'] as const;
const EXTRA_FORMATS: Record<string, string> = { parquet: 'parquet', geojson: 'geojson', kml: 'kml', zip: 'shapefile', csv: 'csv' };
const byCatalog = new WeakMap<object, Map<string, Classified>>();

function catalogIndex(catalog: CatalogLike): Map<string, Classified> {
  let idx = byCatalog.get(catalog);
  if (idx) return idx;
  idx = new Map();
  for (const l of catalog.layers) {
    for (const format of DOWNLOAD_FORMATS) {
      const url = (l[format] as { url?: string } | null | undefined)?.url;
      const m = url?.match(/^https?:\/\/[^/]+\/(.+)$/);
      if (m) idx.set(m[1], { layer_id: l.id, state_code: '', format });
    }
  }
  byCatalog.set(catalog, idx);
  return idx;
}

export function classifyDownload(key: string, catalog: CatalogLike): Classified | null {
  if (!key) return null;
  const listed = catalogIndex(catalog).get(key);
  if (listed) return listed;
  const m = key.match(/^(?:extracts\/[a-z]+\/\d+|community\/[A-Za-z0-9_-]+)\/[^/]+?\.(?:shp\.)?([a-z0-9]+)$/);
  const format = m ? EXTRA_FORMATS[m[1]] : undefined;
  if (!format) return null;
  const cls = classifyKey(key.replace(/\.shp\.zip$/, '.zip'));
  return cls ? { ...cls, format } : null;
}
