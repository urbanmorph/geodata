// DuckDB result rows to GeoJSON features: the geometry column comes back as WKB
// bytes and is parsed here, in JS, rather than with DuckDB's spatial extension,
// which is fragile to install in WASM. Shared by the filtered exports (db.ts)
// and parquet uploads on /preview (parse-geo.ts). No DuckDB import, so testable.
import { parseWKB } from '../functions/lib/wkb-geojson';

export type RowFeature = { geometry: unknown; properties: Record<string, unknown> };

function toUint8Array(v: unknown): Uint8Array | null {
  if (!v) return null;
  if (v instanceof Uint8Array) return v;
  // Arrow may surface BLOB as another typed array or a DataView.
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

// The geometry column's name: GeoParquet from our bakes says `geometry`; GDAL-written
// files say `geom` (airports and others), which the export read as no geometry at all.
const GEOMETRY_COLUMNS = ['geometry', 'geom', 'wkb_geometry', 'the_geom'];

/** Each row with a readable geometry as a feature; BigInts become numbers so
 *  JSON.stringify works. Rows without or with malformed geometry are skipped. */
export function featuresFromRows(rows: Iterable<{ toJSON(): unknown }>): RowFeature[] {
  const out: RowFeature[] = [];
  for (const row of rows) {
    const obj = row.toJSON() as Record<string, unknown>;
    const col = GEOMETRY_COLUMNS.find((c) => obj[c] != null);
    const wkb = col ? toUint8Array(obj[col]) : null;
    if (col) delete obj[col];
    if (!wkb) continue;
    for (const k of Object.keys(obj)) if (typeof obj[k] === 'bigint') obj[k] = Number(obj[k]);
    try {
      out.push({ geometry: parseWKB(wkb), properties: obj });
    } catch {
      // a malformed geometry is skipped, not the whole read
    }
  }
  return out;
}
