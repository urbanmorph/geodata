// Lazy DuckDB-WASM wrapper. Initialised on first query.
// WASM blobs are fetched from JsDelivr CDN (Cloudflare Pages has a 25 MiB per-file
// cap; DuckDB's eh blob is ~34 MiB) — only the JS shim is bundled with our site.
import * as duckdb from '@duckdb/duckdb-wasm';

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    // The worker has to be served same-origin, so wrap the CDN URL in a Blob.
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    return db;
  })();
  return dbPromise;
}

export async function query<T = unknown>(sql: string): Promise<T[]> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const result = await conn.query(sql);
    return result.toArray().map((r) => r.toJSON()) as T[];
  } finally {
    await conn.close();
  }
}

/**
 * COPY a filtered SELECT into a parquet file in DuckDB's VFS, return as a Blob.
 * Caller is responsible for the SQL — make sure the SELECT projects every column
 * you want (use `*` unless you have a reason to drop columns).
 */
export async function exportFilteredParquet(selectSql: string, basename: string): Promise<Blob> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const tmp = `/${basename}.parquet`;
    await conn.query(`COPY (${selectSql}) TO '${tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
    const buf = await db.copyFileToBuffer(tmp);
    await db.dropFile(tmp);
    return new Blob([buf], { type: 'application/octet-stream' });
  } finally {
    await conn.close();
  }
}

/** Query rows from a parquet — geometry column comes back as WKB bytes.
 *  We parse WKB → GeoJSON in JS rather than relying on the DuckDB spatial
 *  extension, which is fragile to install in WASM and threw cryptic errors
 *  on real data. */
async function fetchFeatures(
  parquetUrl: string,
  whereClause: string,
): Promise<Array<{ geometry: unknown; properties: Record<string, unknown> }>> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const where = whereClause ? `WHERE ${whereClause}` : '';
    const sql = `SELECT * FROM '${parquetUrl}' ${where}`;
    let result;
    try {
      result = await conn.query(sql);
    } catch (e) {
      throw new Error(`query failed: ${(e as Error).message}`);
    }
    const out: Array<{ geometry: unknown; properties: Record<string, unknown> }> = [];
    for (const row of result.toArray()) {
      const obj = row.toJSON() as Record<string, unknown>;
      const raw = obj.geometry;
      delete obj.geometry;
      // Coerce BigInts so JSON.stringify doesn't throw.
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === 'bigint') obj[k] = Number(v);
      }
      const wkb = toUint8Array(raw);
      if (!wkb) continue;
      let geometry: unknown;
      try {
        geometry = parseWKB(wkb);
      } catch {
        continue; // skip malformed geometries instead of killing the export
      }
      out.push({ geometry, properties: obj });
    }
    return out;
  } finally {
    await conn.close();
  }
}

function toUint8Array(v: unknown): Uint8Array | null {
  if (!v) return null;
  if (v instanceof Uint8Array) return v;
  // Arrow may surface BLOB as a typed array via different paths
  if (ArrayBuffer.isView(v)) return new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

// ----- WKB → GeoJSON parser (ISO WKB, the format DuckDB uses for geometry blobs) -----

type Geometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPoint'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] };

export function parseWKB(buf: Uint8Array): Geometry {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  function readGeom(): Geometry {
    const le = dv.getUint8(p) === 1; p += 1;
    const typeWithFlags = dv.getUint32(p, le); p += 4;
    // Strip Z/M flags. Two encodings in the wild:
    //   ISO WKB:  base type + 1000*Z + 2000*M + 3000*ZM    (e.g. 1001 = Point Z)
    //   EWKB:     base type | 0x80000000 (Z) | 0x40000000 (M) | 0x20000000 (SRID)
    const isEWKB = (typeWithFlags & 0xE0000000) !== 0;
    const t = isEWKB ? typeWithFlags & 0x0fff : typeWithFlags % 1000 || typeWithFlags;
    const hasZ = isEWKB
      ? (typeWithFlags & 0x80000000) !== 0
      : ((typeWithFlags % 4000) >= 1000 && (typeWithFlags % 4000) < 2000) || typeWithFlags >= 3000;
    const hasM = isEWKB
      ? (typeWithFlags & 0x40000000) !== 0
      : ((typeWithFlags % 4000) >= 2000 && (typeWithFlags % 4000) < 3000) || typeWithFlags >= 3000;
    const hasSRID = isEWKB && (typeWithFlags & 0x20000000) !== 0;
    if (hasSRID) p += 4; // skip the SRID int
    const ptStride = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
    function pt(): [number, number] {
      const x = dv.getFloat64(p, le); p += 8;
      const y = dv.getFloat64(p, le); p += 8;
      p += 8 * (ptStride - 2); // skip Z/M doubles
      return [x, y];
    }
    function line(): [number, number][] {
      const n = dv.getUint32(p, le); p += 4;
      const out: [number, number][] = [];
      for (let i = 0; i < n; i++) out.push(pt());
      return out;
    }
    function poly(): [number, number][][] {
      const rn = dv.getUint32(p, le); p += 4;
      const rings: [number, number][][] = [];
      for (let r = 0; r < rn; r++) rings.push(line());
      return rings;
    }
    switch (t) {
      case 1: return { type: 'Point', coordinates: pt() };
      case 2: return { type: 'LineString', coordinates: line() };
      case 3: return { type: 'Polygon', coordinates: poly() };
      case 4: {
        const n = dv.getUint32(p, le); p += 4;
        const coords: [number, number][] = [];
        for (let i = 0; i < n; i++) coords.push((readGeom() as { coordinates: [number, number] }).coordinates);
        return { type: 'MultiPoint', coordinates: coords };
      }
      case 5: {
        const n = dv.getUint32(p, le); p += 4;
        const lines: [number, number][][] = [];
        for (let i = 0; i < n; i++) lines.push((readGeom() as { coordinates: [number, number][] }).coordinates);
        return { type: 'MultiLineString', coordinates: lines };
      }
      case 6: {
        const n = dv.getUint32(p, le); p += 4;
        const polys: [number, number][][][] = [];
        for (let i = 0; i < n; i++) polys.push((readGeom() as { coordinates: [number, number][][] }).coordinates);
        return { type: 'MultiPolygon', coordinates: polys };
      }
      case 7: {
        const n = dv.getUint32(p, le); p += 4;
        const geoms: Geometry[] = [];
        for (let i = 0; i < n; i++) geoms.push(readGeom());
        return { type: 'GeometryCollection', geometries: geoms };
      }
      default:
        throw new Error('unsupported WKB type ' + t);
    }
  }
  return readGeom();
}

export async function exportFilteredGeoJSON(
  parquetUrl: string,
  whereClause: string,
): Promise<Blob> {
  const feats = await fetchFeatures(parquetUrl, whereClause);
  const fc = {
    type: 'FeatureCollection',
    features: feats.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: f.properties })),
  };
  return new Blob([JSON.stringify(fc)], { type: 'application/geo+json' });
}

export async function exportFilteredKML(
  parquetUrl: string,
  whereClause: string,
  layerName: string,
): Promise<Blob> {
  const feats = await fetchFeatures(parquetUrl, whereClause);
  const kml = geoJSONFeaturesToKML(feats, layerName);
  return new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
}

// --- inline GeoJSON → KML conversion (avoids a dep; handles Polygon/MultiPolygon/Point) ---
// Keep in sync with scripts/bake_extracts.py KML section

// Try most-specific first (village name) so a feature's KML <name> matches
// the level you're looking at, not its parent.
const NAME_KEYS = [
  'vilname11', 'vilnam_soi', 'vname',     // village
  'blkname11', 'blkname', 'block_name',   // block
  'sdtname', 'subdt_name',                // sub-district
  'dtname',                                // district
  'stname', 'STNAME',                     // state
  'NAME', 'name',                          // generic fallback
];

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function geoJSONFeaturesToKML(
  feats: Array<{ geometry: unknown; properties: Record<string, unknown> }>,
  layerName: string,
): string {
  const placemarks = feats
    .map((f) => {
      const name = NAME_KEYS.map((k) => f.properties?.[k]).find((v) => v != null) ?? '';
      const extData = Object.entries(f.properties)
        .filter(([, v]) => v != null && v !== '')
        .map(
          ([k, v]) => `<Data name="${escXml(k)}"><value>${escXml(String(v))}</value></Data>`,
        )
        .join('');
      const geom = geometryToKML(f.geometry);
      return `<Placemark><name>${escXml(String(name))}</name><ExtendedData>${extData}</ExtendedData>${geom}</Placemark>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>${escXml(layerName)}</name>${placemarks}</Document>
</kml>`;
}

function coordPair(c: [number, number]): string {
  return `${c[0]},${c[1]}`;
}

function ring(r: [number, number][]): string {
  return `<LinearRing><coordinates>${r.map(coordPair).join(' ')}</coordinates></LinearRing>`;
}

function polygon(p: [number, number][][]): string {
  const [outer, ...inners] = p;
  return `<Polygon><outerBoundaryIs>${ring(outer)}</outerBoundaryIs>${inners
    .map((i) => `<innerBoundaryIs>${ring(i)}</innerBoundaryIs>`)
    .join('')}</Polygon>`;
}

function geometryToKML(g: unknown): string {
  if (!g || typeof g !== 'object' || !('type' in g)) return '';
  const geom = g as Geometry;
  switch (geom.type) {
    case 'Point':
      return `<Point><coordinates>${coordPair(geom.coordinates)}</coordinates></Point>`;
    case 'LineString':
      return `<LineString><coordinates>${geom.coordinates.map(coordPair).join(' ')}</coordinates></LineString>`;
    case 'Polygon':
      return polygon(geom.coordinates);
    case 'MultiPolygon':
      return `<MultiGeometry>${geom.coordinates.map(polygon).join('')}</MultiGeometry>`;
    case 'MultiLineString':
      return `<MultiGeometry>${geom.coordinates
        .map(
          (line) =>
            `<LineString><coordinates>${line.map(coordPair).join(' ')}</coordinates></LineString>`,
        )
        .join('')}</MultiGeometry>`;
    case 'GeometryCollection':
      return `<MultiGeometry>${geom.geometries.map(geometryToKML).join('')}</MultiGeometry>`;
    default:
      return '';
  }
}

