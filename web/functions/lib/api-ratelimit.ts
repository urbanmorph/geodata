/**
 * Per-minute rate limiter for API v1 endpoints.
 * Uses the existing rate_limits D1 table with an "api:" prefix on the key.
 * Separate from the submission rate limiter (which uses raw IP hashes).
 *
 * One atomic statement per request: insert the key, or bump its count (and
 * restart the window once a minute has passed), returning the new state. A
 * read-then-write let a parallel burst slip past the limit and cost two D1
 * round trips before every API call.
 */

type RunnableD1 = Pick<D1Database, 'prepare'>;

const MINUTE_MS = 60 * 1000;

const BUMP_SQL = `
  INSERT INTO rate_limits (ip_hash, hour_window_start, hour_count, day_window_start, day_count)
  VALUES (?1, ?2, 1, ?2, 0)
  ON CONFLICT (ip_hash) DO UPDATE SET
    hour_count = CASE WHEN (julianday(?2) - julianday(hour_window_start)) * 86400000 >= ${MINUTE_MS}
                      THEN 1 ELSE hour_count + 1 END,
    hour_window_start = CASE WHEN (julianday(?2) - julianday(hour_window_start)) * 86400000 >= ${MINUTE_MS}
                             THEN ?2 ELSE hour_window_start END
  RETURNING hour_window_start, hour_count`;

export async function checkApiRateLimit(
  db: RunnableD1,
  ipHash: string,
  limitPerMinute: number,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const now = Date.now();
  const row = (await db
    .prepare(BUMP_SQL)
    .bind(`api:${ipHash}`, new Date(now).toISOString())
    .first()) as { hour_window_start: string; hour_count: number } | null;

  if (!row || row.hour_count <= limitPerMinute) return { ok: true };
  const windowStart = new Date(row.hour_window_start).getTime();
  return { ok: false, retryAfter: Math.max(1, Math.ceil((windowStart + MINUTE_MS - now) / 1000)) };
}
