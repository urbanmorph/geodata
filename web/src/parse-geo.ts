// Shared geo-file parser used by /verify and /submit. Browser-only.
// Lazy-loads heavy deps (JSZip for KMZ, DuckDB for Parquet) so the cost
// only lands when a user actually drops that format.

import { kml as kmlToGeoJSON, gpx as gpxToGeoJSON, tcx as tcxToGeoJSON } from '@tmcw/togeojson';
import { normaliseFC, type FC } from './validate';

export type Format = 'geojson' | 'json' | 'kml' | 'kmz' | 'gpx' | 'tcx' | 'parquet';

export type ParsePhase = 'parsing' | 'unzipping' | 'duckdb';
export type ParseOpts = { onPhase?: (p: ParsePhase) => void };

export async function fileToFC(file: File, opts: ParseOpts = {}): Promise<{ fc: FC; format: Format }> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.geojson') || name.endsWith('.json')) {
    opts.onPhase?.('parsing');
    const obj = JSON.parse(await file.text());
    return { fc: normaliseFC(obj), format: name.endsWith('.geojson') ? 'geojson' : 'json' };
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
    const { getDb, parseWKB } = await import('./db');
    const db = await getDb();
    await db.registerFileBuffer('parse-geo.parquet', new Uint8Array(await file.arrayBuffer()));
    const conn = await db.connect();
    try {
      const result = await conn.query("SELECT * FROM 'parse-geo.parquet'");
      const rows = result.toArray();
      const features: FC['features'] = [];
      for (const row of rows) {
        const obj = row.toJSON() as Record<string, unknown>;
        const geomBytes = obj.geometry as Uint8Array | undefined;
        delete obj.geometry;
        for (const k of Object.keys(obj)) if (typeof obj[k] === 'bigint') obj[k] = Number(obj[k]);
        if (!(geomBytes instanceof Uint8Array)) continue;
        try {
          features.push({ type: 'Feature', geometry: parseWKB(geomBytes), properties: obj });
        } catch {
          /* skip malformed */
        }
      }
      return { fc: { type: 'FeatureCollection', features }, format: 'parquet' };
    } finally {
      await conn.close();
      await db.dropFile('parse-geo.parquet');
    }
  }

  throw new Error('Unsupported file type. Accepts: .geojson, .json, .kml, .kmz, .gpx, .tcx, .parquet');
}
