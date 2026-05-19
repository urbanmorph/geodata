// Lazy DuckDB-WASM wrapper. Initialised on first query — adds ~2 MB to the bundle.
// Used by v2 filter/export to slice remote parquet via HTTP range requests.
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
  eh: { mainModule: duckdb_wasm_eh, mainWorker: eh_worker },
};

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const bundle = await duckdb.selectBundle(BUNDLES);
    const worker = new Worker(bundle.mainWorker!, { type: 'module' });
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
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

/**
 * Probe a remote parquet's schema. Returns column names + types.
 * Cheap: DuckDB only reads the parquet footer (a few KB).
 */
export async function schemaOf(parquetUrl: string): Promise<Array<{ name: string; type: string }>> {
  const rows = await query<{ column_name: string; column_type: string }>(
    `DESCRIBE SELECT * FROM '${parquetUrl}' LIMIT 0`,
  );
  return rows.map((r) => ({ name: r.column_name, type: r.column_type }));
}
