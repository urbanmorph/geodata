// Submission rate limit per hashed IP: 5 an hour and 20 a day, on the shared
// rate_limits table. Each window is one atomic upsert (shared/rate-window.ts);
// the old SELECT-then-UPDATE let a parallel burst past the limit.
import { bumpWindow, WINDOW_MS, type RateWindow } from '../../../shared/rate-window';

type RunnableD1 = Pick<D1Database, 'prepare'>;

const HOUR_LIMIT = 5;
const DAY_LIMIT = 20;

export async function checkRateLimit(
  db: RunnableD1,
  ipHash: string,
  now: () => Date = () => new Date(),
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const t = now().getTime();
  if (!(await bumpWindow(db, ipHash, 'hour', HOUR_LIMIT, t))) return refused(db, ipHash, 'hour', t);
  if (!(await bumpWindow(db, ipHash, 'day', DAY_LIMIT, t))) return refused(db, ipHash, 'day', t);
  return { ok: true };
}

/** A refusal with the seconds until the full window ends (read only on refusal). */
async function refused(db: RunnableD1, ipHash: string, window: RateWindow, t: number): Promise<{ ok: false; retryAfter: number }> {
  const col = window === 'hour' ? 'hour_window_start' : 'day_window_start';
  const row = await db.prepare(`SELECT ${col} AS start FROM rate_limits WHERE ip_hash = ?`).bind(ipHash).first<{ start: string }>();
  const start = row ? new Date(row.start).getTime() : t;
  return { ok: false, retryAfter: Math.max(1, Math.ceil((start + WINDOW_MS[window] - t) / 1000)) };
}
