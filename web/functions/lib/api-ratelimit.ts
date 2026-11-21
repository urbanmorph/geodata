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

import { ipSalt, sha256Hex } from './crypto';

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

/** What one client is: an IPv4 address, or an IPv6 address's /64 (a single
 *  host is handed a whole /64, so per-address keys let it mint new buckets). */
export function rateKeySource(ip: string): string {
  if (!ip.includes(':')) return ip;
  const addr = ip.toLowerCase().replace(/%.*$/, '');
  const width = (parts: string[]) => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0);
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - width(h) - width(t))).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

/** The hashed rate-limit key for a request: CF-Connecting-IP only (never
 *  X-Forwarded-For, which a client sets), salted with IP_SALT when it is set. */
export function apiRateKey(request: Request, salt?: string): Promise<string> {
  const source = rateKeySource(request.headers.get('cf-connecting-ip') || 'unknown');
  const s = ipSalt(salt, ''); // unsalted (as before) when unset, and said so in the log
  return sha256Hex(s ? `${source}|${s}` : source);
}

// The isolate answers first; D1 (the limit across isolates) is bumped after the
// answer, and a key it reports over the limit is refused here until its window
// ends. A token bucket per key catches a burst on one isolate before D1 has
// answered. Locate has its own key (its own D1 row): sharing the general row
// let 61 /query calls in a minute refuse the next locate.
const STATE_MAX = 10_000;
const blockedUntil = new Map<string, number>();
const buckets = new Map<string, { tokens: number; at: number }>();

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > STATE_MAX) map.delete(map.keys().next().value!);
}

export function __resetApiLimiterForTest(): void {
  blockedUntil.clear();
  buckets.clear();
}

type Verdict = { ok: true } | { ok: false; retryAfter: number };

/** This isolate's token bucket for `id` (`limit` a minute): take one token, or
 *  the seconds until one is free. No D1: a per-isolate burst check. */
export function takeToken(id: string, limit: number, now = Date.now()): Verdict {
  const perMs = limit / MINUTE_MS;
  const b = buckets.get(id);
  const tokens = b ? Math.min(limit, b.tokens + (now - b.at) * perMs) : limit;
  if (tokens < 1) {
    remember(buckets, id, { tokens, at: now });
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)) };
  }
  remember(buckets, id, { tokens: tokens - 1, at: now });
  return { ok: true };
}

/** Allow or refuse one call now; D1 is bumped in waitUntil (failures ignored). */
export function apiLimit(opts: {
  db: RunnableD1;
  key: string;
  limit: number;
  waitUntil(p: Promise<unknown>): void;
}): Verdict {
  const { db, key, limit } = opts;
  const now = Date.now();

  const until = blockedUntil.get(key);
  if (until !== undefined) {
    if (until > now) return { ok: false, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) };
    blockedUntil.delete(key);
  }

  const burst = takeToken(key, limit, now);
  if (!burst.ok) return burst;

  opts.waitUntil(
    checkApiRateLimit(db, key, limit)
      .then((r) => { if (!r.ok) remember(blockedUntil, key, Date.now() + r.retryAfter * 1000); })
      .catch(() => {}), // a D1 failure should not block reads
  );
  return { ok: true };
}

/** Calls a minute per client: locate (point-in-polygon over many layers) and the rest. */
export const API_LIMIT = 120;
export const LOCATE_LIMIT = 60;

/** The /api/v1 (and hosted MCP) limit for one request: locate counts on its own key. */
/** Point lookups (locate, a layer's locate, ground) share the tighter locate limit: each reads many layers. */
export function isPointLookup(pathname: string): boolean {
  return pathname.endsWith('/locate') || pathname === '/api/v1/ground';
}

export async function apiLimitFor(
  request: Request,
  env: { DB: RunnableD1; IP_SALT?: string },
  isLocate: boolean,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Verdict> {
  const key = await apiRateKey(request, env.IP_SALT);
  return isLocate
    ? apiLimit({ db: env.DB, key: `locate:${key}`, limit: LOCATE_LIMIT, waitUntil })
    : apiLimit({ db: env.DB, key, limit: API_LIMIT, waitUntil });
}
