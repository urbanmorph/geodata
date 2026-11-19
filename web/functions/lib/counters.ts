// D1 helpers for download_counts.
// Functions kept tiny so the tests can mock D1 with a fake `prepare`.

type RunnableD1 = Pick<D1Database, 'prepare'>;

/** Downloads one address can add to the counts in a minute (more still download). */
export const DL_COUNT_PER_MINUTE = 30;

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

/** {layer: {format: n}, _total}, adding up every row for a layer and format
 *  (per-state extracts and the R2 backfill rows are separate rows). */
export function shapeDownloadCounts(
  rows: { layer_id: string; format: string; count: number }[],
): Record<string, Record<string, number> | number> {
  const counts: Record<string, Record<string, number>> = {};
  let total = 0;
  for (const r of rows) {
    const layer = (counts[r.layer_id] ??= {});
    layer[r.format] = (layer[r.format] ?? 0) + r.count;
    total += r.count;
  }
  return { ...counts, _total: total };
}

/** Every download count from D1, shaped by shapeDownloadCounts (throws on a D1 failure). */
export async function downloadCounts(db: Pick<D1Database, 'prepare'>): Promise<Record<string, Record<string, number> | number>> {
  const rows = await db.prepare('SELECT layer_id, format, count FROM download_counts')
    .all<{ layer_id: string; format: string; count: number }>();
  return shapeDownloadCounts(rows.results ?? []);
}
