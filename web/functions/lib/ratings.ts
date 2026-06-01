// Single-direction "Useful" voting on community submissions.
// (submission_id, ip_hash) is the primary key — one vote per IP per
// submission, mutable: vote=1 (useful) or 0 (clear → delete row).
// The Tally type retains `down` + `score` for back-compat reads of
// pre-existing rows; new writes cannot add downvotes (api/rate.ts
// rejects vote=-1).

type RunnableD1 = Pick<D1Database, 'prepare'>;

export type Vote = 1 | 0;
export type Tally = { up: number; down: number; score: number };

export async function recordVote(
  db: RunnableD1,
  submissionId: string,
  ipHash: string,
  vote: Vote,
  now: () => Date = () => new Date(),
): Promise<Tally & { myVote: Vote }> {
  if (vote === 0) {
    await db
      .prepare(`DELETE FROM submission_ratings WHERE submission_id = ? AND ip_hash = ?`)
      .bind(submissionId, ipHash)
      .run();
  } else {
    await db
      .prepare(
        `INSERT OR REPLACE INTO submission_ratings (submission_id, ip_hash, created_at, vote)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(submissionId, ipHash, now().toISOString(), vote)
      .run();
  }
  const tally = await countVotes(db, submissionId);
  return { ...tally, myVote: vote };
}

export async function countVotes(db: RunnableD1, submissionId: string): Promise<Tally> {
  const row = (await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0) AS up,
         COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0) AS down
       FROM submission_ratings WHERE submission_id = ?`,
    )
    .bind(submissionId)
    .first()) as { up: number; down: number } | null;
  const up = row?.up ?? 0;
  const down = row?.down ?? 0;
  return { up, down, score: up - down };
}

// Bulk up-vote tally for the home grid patcher. Returns a Map keyed by
// submission_id with the count of vote=1 rows. Legacy vote=-1 rows are
// ignored to match the rest of the UI (single-direction Useful vote).
// Submissions with zero useful votes aren't included — the caller treats
// missing entries as 0, matching the baked default.
export async function countAllUpVotes(db: RunnableD1): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const rows = await db
    .prepare(`SELECT submission_id, COUNT(*) AS up FROM submission_ratings WHERE vote = 1 GROUP BY submission_id`)
    .all<{ submission_id: string; up: number }>();
  for (const r of rows.results ?? []) out.set(r.submission_id, Number(r.up) || 0);
  return out;
}

export async function getMyVote(
  db: RunnableD1,
  submissionId: string,
  ipHash: string,
): Promise<Vote> {
  const row = (await db
    .prepare(`SELECT vote FROM submission_ratings WHERE submission_id = ? AND ip_hash = ?`)
    .bind(submissionId, ipHash)
    .first()) as { vote: 1 | -1 } | null;
  return (row?.vote as Vote) ?? 0;
}
