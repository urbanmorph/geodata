// Per-hashed-IP rate limits on the shared rate_limits table (spec → Anti-abuse:
// 5 collections/day, 200 records/hour). collect uses a DISTINCT IP_SALT from web,
// so its rows never collide with submit's. Records use the hour window; creates
// use the day window — independent columns on the same row.

type DB = Pick<D1Database, 'prepare'>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface RLRow {
  hour_window_start: string;
  hour_count: number;
  day_window_start: string;
  day_count: number;
}

async function bump(db: DB, ipHash: string, window: 'hour' | 'day', limit: number): Promise<boolean> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const row = (await db
    .prepare(`SELECT hour_window_start, hour_count, day_window_start, day_count FROM rate_limits WHERE ip_hash = ?`)
    .bind(ipHash)
    .first()) as RLRow | null;

  if (!row) {
    await db
      .prepare(
        `INSERT INTO rate_limits (ip_hash, hour_window_start, hour_count, day_window_start, day_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(ipHash, nowIso, window === 'hour' ? 1 : 0, nowIso, window === 'day' ? 1 : 0)
      .run();
    return true;
  }

  let { hour_window_start, hour_count, day_window_start, day_count } = row;
  if (nowMs - Date.parse(hour_window_start) >= HOUR_MS) { hour_window_start = nowIso; hour_count = 0; }
  if (nowMs - Date.parse(day_window_start) >= DAY_MS) { day_window_start = nowIso; day_count = 0; }

  const count = window === 'hour' ? hour_count : day_count;
  const allowed = count < limit;
  if (allowed) {
    if (window === 'hour') hour_count += 1;
    else day_count += 1;
  }

  await db
    .prepare(
      `UPDATE rate_limits SET hour_window_start = ?, hour_count = ?, day_window_start = ?, day_count = ? WHERE ip_hash = ?`,
    )
    .bind(hour_window_start, hour_count, day_window_start, day_count, ipHash)
    .run();

  return allowed;
}

export const checkRecordRate = (db: DB, ipHash: string): Promise<boolean> => bump(db, ipHash, 'hour', 200);
export const checkCreateRate = (db: DB, ipHash: string): Promise<boolean> => bump(db, ipHash, 'day', 5);
// Per-API-key day window (its own rate_limits row, keyed by the key hash).
export const checkKeyDayRate = (db: DB, keyHash: string, limit: number): Promise<boolean> => bump(db, keyHash, 'day', limit);
