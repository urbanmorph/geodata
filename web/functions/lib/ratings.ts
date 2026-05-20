// Reddit-style up/down voting on community submissions.
// (submission_id, ip_hash) is the primary key — one vote per IP per
// submission, mutable: vote=1 (up), -1 (down), or 0 (clear → delete row).

type RunnableD1 = Pick<D1Database, 'prepare'>;

export type Vote = 1 | -1 | 0;
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
