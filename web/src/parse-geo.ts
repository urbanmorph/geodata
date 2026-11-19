// The geo-file parser behind /preview (a dropped, picked or handed-off file). Browser-only.
// Lazy-loads heavy deps (JSZip for KMZ, DuckDB for Parquet) so the cost
// only lands when a user actually drops that format.

import { kml as kmlToGeoJSON, gpx as gpxToGeoJSON, tcx as tcxToGeoJSON } from '@tmcw/togeojson';
import { normaliseFC, type FC } from './validate';

export type Format = 'geojson' | 'json' | 'kml' | 'kmz' | 'gpx' | 'tcx' | 'parquet';

export type ParsePhase = 'parsing' | 'unzipping' | 'duckdb';
export type ParseOpts = { onPhase?: (p: ParsePhase) => void };

/** The features, the format, and for GeoJSON the parsed object itself (its `crs`
 *  member, which normaliseFC drops, is read from it). */
export type Parsed = { fc: FC; format: Format; raw?: unknown };

export async function fileToFC(file: File, opts: ParseOpts = {}): Promise<Parsed> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.geojson') || name.endsWith('.json')) {
    opts.onPhase?.('parsing');
    const raw: unknown = JSON.parse(await file.text());
    return { fc: normaliseFC(raw), format: name.endsWith('.geojson') ? 'geojson' : 'json', raw };
  }

  if (name.endsWith('.kml')) {
    opts.onPhase?.('parsing');
    const xml = new DOMParser().parseFromString(await file.text(), 'text/xml');
    return { fc: kmlToGeoJSON(xml) as FC, format: 'kml' };
  }

  if (name.endsWith('.gpx')) {
    opts.onPhase?.('parsing');
    const xml = new DOMParser().parseFromString(await file.text(), 'text/xml');
    return { fc: gpxToGeoJSON(xml) as FC, format: 'gpx' };
  }

  if (name.endsWith('.tcx')) {
    opts.onPhase?.('parsing');
    const xml = new DOMParser().parseFromString(await file.text(), 'text/xml');
    return { fc: tcxToGeoJSON(xml) as FC, format: 'tcx' };
  }

  if (name.endsWith('.kmz')) {
    opts.onPhase?.('unzipping');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const kmlEntry = Object.values(zip.files).find((f) => /\.kml$/i.test(f.name) && !f.dir);
    if (!kmlEntry) throw new Error('KMZ contains no .kml file');
    const xml = new DOMParser().parseFromString(await kmlEntry.async('text'), 'text/xml');
    return { fc: kmlToGeoJSON(xml) as FC, format: 'kmz' };
  }

  if (name.endsWith('.parquet')) {
    opts.onPhase?.('duckdb');
    const { getDb, readFeatures } = await import('./db');
    const db = await getDb();
    await db.registerFileBuffer('parse-geo.parquet', new Uint8Array(await file.arrayBuffer()));
    try {
      const features = (await readFeatures("'parse-geo.parquet'"))
        .map(({ geometry, properties }) => ({ type: 'Feature' as const, geometry, properties }));
      return { fc: { type: 'FeatureCollection', features }, format: 'parquet' };
    } finally {
      await db.dropFile('parse-geo.parquet');
    }
  }

  throw new Error('Unsupported file type. Accepts: .geojson, .json, .kml, .kmz, .gpx, .tcx, .parquet');
}
