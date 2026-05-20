// Sliding-window rate-limit per hashed IP. Hour window + day window.
// One row per IP in `rate_limits`; SELECT-then-UPDATE-or-INSERT.

type RunnableD1 = Pick<D1Database, 'prepare'>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_LIMIT = 5;
const DAY_LIMIT = 20;

type Row = {
  hour_window_start: string;
  hour_count: number;
  day_window_start: string;
  day_count: number;
};

export async function checkRateLimit(
  db: RunnableD1,
  ipHash: string,
  now: () => Date = () => new Date(),
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const t = now();
  const tIso = t.toISOString();

  const cur = (await db
    .prepare(
      'SELECT hour_window_start, hour_count, day_window_start, day_count FROM rate_limits WHERE ip_hash = ?',
    )
    .bind(ipHash)
    .first()) as Row | null;

  if (!cur) {
    await db
      .prepare(
        'INSERT INTO rate_limits (ip_hash, hour_window_start, hour_count, day_window_start, day_count) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(ipHash, tIso, 1, tIso, 1)
      .run();
    return { ok: true };
  }

  let hourStart = new Date(cur.hour_window_start).getTime();
  let hourCount = cur.hour_count;
  let dayStart = new Date(cur.day_window_start).getTime();
  let dayCount = cur.day_count;

  if (t.getTime() - hourStart >= HOUR_MS) {
    hourStart = t.getTime();
    hourCount = 0;
  }
  if (t.getTime() - dayStart >= DAY_MS) {
    dayStart = t.getTime();
    dayCount = 0;
  }

  if (hourCount >= HOUR_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((hourStart + HOUR_MS - t.getTime()) / 1000));
    return { ok: false, retryAfter };
  }
  if (dayCount >= DAY_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((dayStart + DAY_MS - t.getTime()) / 1000));
    return { ok: false, retryAfter };
  }

  hourCount++;
  dayCount++;

  await db
    .prepare(
      'UPDATE rate_limits SET hour_window_start = ?, hour_count = ?, day_window_start = ?, day_count = ? WHERE ip_hash = ?',
    )
    .bind(new Date(hourStart).toISOString(), hourCount, new Date(dayStart).toISOString(), dayCount, ipHash)
    .run();

  return { ok: true };
}
