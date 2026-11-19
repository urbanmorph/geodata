// One atomic rate-limit step on the shared rate_limits table (web submit,
// collect). Each row has an hour window and a day window: independent columns
// on the same row, keyed by a hashed IP (optionally prefixed).

type RunResult = { meta?: { changes?: number } };
type DB = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<RunResult> } } };

export type RateWindow = 'hour' | 'day';

export const WINDOW_MS: Readonly<Record<RateWindow, number>> = { hour: 3_600_000, day: 86_400_000 };

const COLUMNS = {
  hour: { start: 'hour_window_start', count: 'hour_count' },
  day: { start: 'day_window_start', count: 'day_count' },
} as const;

/** Takes one from the key's allowance in this window; false when it is used up.
 *  One atomic upsert (no read-then-write), so two first requests at once both
 *  count and neither fails on the insert, and a parallel burst can't slip past
 *  the limit. A window older than its length starts again at 1. Times are ISO
 *  strings, which compare in time order. */
export async function bumpWindow(db: DB, key: string, window: RateWindow, limit: number, nowMs = Date.now()): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString();
  const expired = new Date(nowMs - WINDOW_MS[window]).toISOString();
  const { start, count } = COLUMNS[window];
  const r = await db
    .prepare(
      `INSERT INTO rate_limits (ip_hash, hour_window_start, hour_count, day_window_start, day_count)
       VALUES (?1, ?2, ?4, ?2, ?5)
       ON CONFLICT(ip_hash) DO UPDATE SET
         ${count} = CASE WHEN ${start} <= ?3 THEN 1 ELSE ${count} + 1 END,
         ${start} = CASE WHEN ${start} <= ?3 THEN ?2 ELSE ${start} END
       WHERE ${start} <= ?3 OR ${count} < ?6`,
    )
    .bind(key, nowIso, expired, window === 'hour' ? 1 : 0, window === 'day' ? 1 : 0, limit)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}
