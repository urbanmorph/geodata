// Rate limits on the shared rate_limits table (spec → Anti-abuse: 5 collections
// per day per network, 200 records per hour per link and network). Keys are
// hashed IPs (collect uses a DISTINCT IP_SALT from web, so its rows never
// collide with submit's), optionally prefixed. Records use the hour window;
// creates use the day window: independent columns on the same row.

type DB = Pick<D1Database, 'prepare'>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const WINDOWS = {
  hour: { start: 'hour_window_start', count: 'hour_count', ms: HOUR_MS },
  day: { start: 'day_window_start', count: 'day_count', ms: DAY_MS },
} as const;

/** Takes one from the key's allowance in this window; false when it is used up.
 *  One atomic upsert (no read-then-write), so two first requests at once both
 *  count and neither fails on the insert. A window older than its length starts
 *  again at 1. Times are ISO strings, which compare in time order. */
async function bump(db: DB, key: string, window: 'hour' | 'day', limit: number): Promise<boolean> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expired = new Date(nowMs - WINDOWS[window].ms).toISOString();
  const { start, count } = WINDOWS[window];
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

/** Points per hour, per link and network: two teams behind one mobile carrier's
 *  shared IP (CGNAT) don't eat each other's budget. */
export const checkRecordRate = (db: DB, key: string): Promise<boolean> => bump(db, key, 'hour', 200);
export const recordRateKey = (linkId: string, ipHash: string): string => `rec:${linkId}:${ipHash}`;
export const checkCreateRate = (db: DB, ipHash: string): Promise<boolean> => bump(db, ipHash, 'day', 5);
// Per-API-key day window (its own rate_limits row, keyed by the key hash).
export const checkKeyDayRate = (db: DB, keyHash: string, limit: number): Promise<boolean> => bump(db, keyHash, 'day', limit);
// Keyring writes: their own rate_limits row (prefixed key) so sync never eats
// into a contributor's record budget.
export const checkKeyringRate = (db: DB, ipHash: string): Promise<boolean> => bump(db, `kr:${ipHash}`, 'hour', 120);
// Photo uploads: their own row (up to 3 photos a point, so 3x the record budget).
export const checkPhotoRate = (db: DB, ipHash: string): Promise<boolean> => bump(db, `ph:${ipHash}`, 'hour', 600);
