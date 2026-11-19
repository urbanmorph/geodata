// Lazy DuckDB-WASM wrapper. Initialised on first query.
// WASM blobs are fetched from JsDelivr CDN (Cloudflare Pages has a 25 MiB per-file
// cap; DuckDB's eh blob is ~34 MiB) — only the JS shim is bundled with our site.
import * as duckdb from '@duckdb/duckdb-wasm';
import { featuresToKML } from '../../shared/kml.mjs';
import { featuresFromRows, type RowFeature } from './wkb-rows';
import { escString } from './filter-where';

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
    try {
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    } catch (e) {
      worker.terminate();
      throw e;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
    return db;
  })();
  // A failed start (the CDN, a flaky connection) is not kept: the next call tries again.
  dbPromise.catch(() => { dbPromise = null; });
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
    return new Blob([buf as BlobPart], { type: 'application/octet-stream' });
  } finally {
    await conn.close();
  }
}

/** The features a SELECT over `from` (a quoted SQL source: a parquet URL or a
 *  registered file) returns, optionally filtered by `whereClause`. */
export async function readFeatures(from: string, whereClause = ''): Promise<RowFeature[]> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const sql = `SELECT * FROM ${from}${whereClause ? ` WHERE ${whereClause}` : ''}`;
    let result;
    try {
      result = await conn.query(sql);
    } catch (e) {
      throw new Error(`query failed: ${(e as Error).message}`);
    }
    return featuresFromRows(result.toArray());
  } finally {
    await conn.close();
  }
}

export async function exportFilteredGeoJSON(
  parquetUrl: string,
  whereClause: string,
): Promise<Blob> {
  const feats = await readFeatures(escString(parquetUrl), whereClause);
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
  const feats = await readFeatures(escString(parquetUrl), whereClause);
  const kml = featuresToKML(feats, layerName);
  return new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
}
