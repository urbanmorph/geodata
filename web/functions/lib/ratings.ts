// Thumbs-up ratings for community submissions. PRIMARY KEY (submission_id, ip_hash)
// makes inserts idempotent; we use INSERT OR IGNORE + meta.changes to tell
// the user whether their click registered or was already-there.

type RunnableD1 = Pick<D1Database, 'prepare'>;

export async function recordRating(
  db: RunnableD1,
  submissionId: string,
  ipHash: string,
  now: () => Date = () => new Date(),
): Promise<{ alreadyRated: boolean; count: number }> {
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO submission_ratings (submission_id, ip_hash, created_at) VALUES (?, ?, ?)`,
    )
    .bind(submissionId, ipHash, now().toISOString())
    .run();
  const alreadyRated = !(ins as { meta?: { changes?: number } }).meta?.changes;
  const count = await countRatings(db, submissionId);
  return { alreadyRated, count };
}

export async function countRatings(db: RunnableD1, submissionId: string): Promise<number> {
  const row = (await db
    .prepare(`SELECT COUNT(*) AS c FROM submission_ratings WHERE submission_id = ?`)
    .bind(submissionId)
    .first()) as { c: number } | null;
  return row?.c ?? 0;
}
