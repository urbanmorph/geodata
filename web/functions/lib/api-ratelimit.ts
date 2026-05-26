/**
 * Per-minute rate limiter for API v1 endpoints.
 * Uses the existing rate_limits D1 table with an "api:" prefix on the key.
 * Separate from the submission rate limiter (which uses raw IP hashes).
 */

type RunnableD1 = Pick<D1Database, 'prepare'>;

const MINUTE_MS = 60 * 1000;

type Row = {
  hour_window_start: string;
  hour_count: number;
};

export async function checkApiRateLimit(
  db: RunnableD1,
  ipHash: string,
  limitPerMinute: number,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const key = `api:${ipHash}`;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const cur = (await db
    .prepare('SELECT hour_window_start, hour_count FROM rate_limits WHERE ip_hash = ?')
    .bind(key)
    .first()) as Row | null;

  if (!cur) {
    await db
      .prepare(
        'INSERT OR IGNORE INTO rate_limits (ip_hash, hour_window_start, hour_count, day_window_start, day_count) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(key, nowIso, 1, nowIso, 0)
      .run();
    return { ok: true };
  }

  let windowStart = new Date(cur.hour_window_start).getTime();
  let count = cur.hour_count;

  if (now - windowStart >= MINUTE_MS) {
    windowStart = now;
    count = 0;
  }

  if (count >= limitPerMinute) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + MINUTE_MS - now) / 1000));
    return { ok: false, retryAfter };
  }

  count++;
  await db
    .prepare('UPDATE rate_limits SET hour_window_start = ?, hour_count = ? WHERE ip_hash = ?')
    .bind(new Date(windowStart).toISOString(), count, key)
    .run();

  return { ok: true };
}
