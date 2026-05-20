// D1 helpers for download_counts + submission_ratings.
// Functions kept tiny so the tests can mock D1 with a fake `prepare`.

type RunnableD1 = Pick<D1Database, 'prepare'>;

export async function incrementDownload(
  db: RunnableD1,
  layer_id: string,
  state_code: string,
  format: string,
): Promise<void> {
  // SQLite UPSERT. Cheap and atomic.
  await db
    .prepare(
      `INSERT INTO download_counts (layer_id, state_code, format, count, last_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(layer_id, state_code, format)
       DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
    )
    .bind(layer_id, state_code, format, new Date().toISOString())
    .run();
}

/** Returns one row per (layer_id, state_code, format). Used by build_catalog
 *  to inline counts into catalog.json. */
export async function listDownloadCounts(
  db: RunnableD1,
): Promise<Array<{ layer_id: string; state_code: string; format: string; count: number }>> {
  const r = await db.prepare('SELECT layer_id, state_code, format, count FROM download_counts').all();
  return (r.results || []) as Array<{
    layer_id: string;
    state_code: string;
    format: string;
    count: number;
  }>;
}
