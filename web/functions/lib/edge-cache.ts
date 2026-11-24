// Function answers in the colo's cache (caches.default). Pages caches static
// files but never a Function's response, so each API call, /view page and OG
// image used to be rebuilt on every request.
//
// Page keys (cacheKey) start with the deploy version (build id and catalog): a deploy
// changes every page key, so there is nothing to purge. API answer keys (answerKey) carry
// the endpoint's answer version and the data it read instead, so a deploy keeps them. An
// answer past its ttl is served stale while a fresh one is computed (stale-while-revalidate
// by hand: the Cache API ignores the header). Callers do their own checks first
// (validation, the layer lookup, countApiUse) and wrap only the work: a hit still counts.

import { apiError } from './http';
import { withTimeout } from './isolate-cache';
import { ANSWER_V, type AnswerEndpoint } from './answer-versions';
import { countedHost } from './usage';

export type EdgeCache = Pick<Cache, 'match' | 'put'>;
/** A KV namespace, as far as the durable second level uses it. */
type AnswersKv = {
  getWithMetadata<M>(key: string, type: 'text'): Promise<{ value: string | null; metadata: M | null }>;
  put(key: string, value: string, opts: { expirationTtl: number; metadata: unknown }): Promise<void>;
};
/** `env.ANSWERS`, when bound, is the durable second level for API answers (cached()). */
type CacheCtx = { request: Request; waitUntil(p: Promise<unknown>): void; env?: unknown };

/** How long the colo serves an answer as fresh (seconds); it is kept as long again to be
 *  served stale while one refresh runs (cached()). Catalog answers can't go stale (the key
 *  moves with the catalog); R2 answers allow for an object replaced under the same key, so
 *  such an answer can outlive an overwrite by up to twice this (2 h; policy is to never
 *  overwrite R2 keys, and a layer refresh changes the catalog, so the key). */
export const EDGE_TTL = { catalog: 86_400, r2: 3_600, page: 86_400, live: 60 } as const;

/** The cache-control the answers carry for browsers and the CDN: catalog API
 *  answers, rendered pages (/view, /c, community files), and live counters. */
export const CACHE_CONTROL = {
  catalog: 'public, max-age=3600, stale-while-revalidate=86400',
  page: 'public, max-age=300, stale-while-revalidate=86400',
  live: 'public, max-age=30, stale-while-revalidate=120',
} as const;

const KEY_ORIGIN ='https://bharatlas.com/__cache/';
// Restores the handler's own cache-control on a hit: the stored copy carries
// the edge ttl instead (the Cache API honours the stored cache-control).
const CLIENT_CC = 'x-client-cache-control';
/** A handler sets this header on a 200 the colo must not keep (a partial answer); it never reaches the client. */
export const NO_STORE = 'x-edge-no-store';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The cache key: version, path, then the query sorted (or left out when the
 *  answer never depends on it). Same key on every host (previews, pages.dev). */
export function cacheKey(version: string, url: URL, opts: { query?: boolean } = {}): string {
  let key = `${KEY_ORIGIN}${version}${url.pathname}`;
  if (opts.query !== false) {
    const q = new URLSearchParams([...url.searchParams].sort(([a, av], [b, bv]) => cmp(a, b) || cmp(av, bv)));
    if ([...q].length) key += `?${q}`;
  }
  return key;
}

/** An API answer's key: the endpoint and its answer version, the identity of the data the
 *  answer read (a layer's catalog entry, or the catalog), then path and sorted query. No
 *  build id: a deploy that changes neither keeps it. A preview (a branch on pages.dev) may
 *  carry new code before its version bump, so its answers are kept apart from the live
 *  site's (bharatlas.com and its pages.dev address, usage.ts countedHost). */
export function answerKey(endpoint: AnswerEndpoint, identity: string, url: URL): string {
  const scope = countedHost(url) ? '' : `preview/${url.hostname}/`;
  return cacheKey(`a/${scope}${endpoint}.v${ANSWER_V[endpoint]}/${identity}`, url);
}

/** The identity of a piece of data for answerKey: a short hash of its JSON. */
export const dataIdentity = (data: unknown): string => hash(JSON.stringify(data));

/** caches.default where the runtime has it (Workers), else null (vitest). */
export function defaultCache(): EdgeCache | null {
  return typeof caches !== 'undefined' && (caches as { default?: Cache }).default ? (caches as unknown as { default: Cache }).default : null;
}

/** A quoted ETag for `s` (a 53-bit cyrb53 hash, base 36). */
export const etagFor = (s: string): string => `"${hash(s)}"`;

function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const strip = (tag: string) => tag.trim().replace(/^W\//, '');

/** 304 when the request's If-None-Match names this response's ETag. */
export function notModified(request: Request, res: Response): Response {
  const etag = res.headers.get('etag');
  const inm = request.headers.get('if-none-match');
  if (!etag || !inm || res.status !== 200) return res;
  const tags = inm.split(',').map(strip);
  if (!tags.includes('*') && !tags.includes(strip(etag))) return res;
  return new Response(null, { status: 304, headers: res.headers });
}

function withHeaders(res: Response, set: Record<string, string | null>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(set)) {
    if (v == null) headers.delete(k);
    else headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** How long a cache lookup may take before the answer is computed instead: a lookup
 *  is milliseconds, and nothing outside a handler's own work may hold an answer up. */
export const MATCH_TIMEOUT_MS = 2_000;

/** `cache.match(key)`, or undefined when it fails or takes longer than `ms`. */
export function matchWithin(cache: EdgeCache, key: string, ms: number): Promise<Response | undefined> {
  return withTimeout(cache.match(key), ms, 'cache lookup').catch(() => undefined);
}

/** When an answer was stored (ms since the epoch), for stale-while-revalidate. */
const STORED_AT = 'x-edge-stored-at';
// Keys being refreshed in the background by this isolate, and since when: one refresh per
// key at a time. A refresh cut off before it ended stops counting after REFRESH_MS.
const refreshing = new Map<string, number>();
const REFRESH_MS = 60_000;

/** `res` kept in the colo under `key` for `ttl` seconds plus as long again to be served
 *  stale, stamped with when it was made (`at`, now unless it came from KV). */
function store(ctx: CacheCtx, cache: EdgeCache, key: string, ttl: number, res: Response, at = Date.now()): void {
  const stored = withHeaders(res.clone(), {
    'cache-control': `public, max-age=${ttl * 2}`,
    [CLIENT_CC]: res.headers.get('cache-control'),
    [STORED_AT]: String(at),
    'x-edge-cache': null,
  });
  ctx.waitUntil(cache.put(key, stored).catch(() => {}));
}

// ── the durable second level: KV, API answers only ──────────────────────────
// caches.default is per data centre: a data centre that never saw an answer recomputed it.
// API answers (answerKey) are also kept in KV (binding ANSWERS, when bound), so it reads
// them in one get. KV keys are at most 512 bytes: the key is a SHA-256 of the cache key.
// The answer's own headers and when it was made ride in the metadata.
type KvMeta = { t: number; ct: string | null; cc: string | null; etag: string | null };
const ANSWER_PREFIX = `${KEY_ORIGIN}a/`;

async function kvKey(key: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return `a1:${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The answer kept in KV for `key`, rebuilt as a response with when it was made; null otherwise. */
async function fromKv(kv: AnswersKv, key: string, ms: number): Promise<{ res: Response; at: number } | null> {
  try {
    const got = await withTimeout(kv.getWithMetadata<KvMeta>(await kvKey(key), 'text'), ms, 'KV lookup');
    if (got.value === null || !got.metadata) return null;
    const m = got.metadata;
    const headers: Record<string, string> = {};
    if (m.ct) headers['content-type'] = m.ct;
    if (m.cc) headers['cache-control'] = m.cc;
    if (m.etag) headers.etag = m.etag;
    return { res: new Response(got.value, { headers }), at: m.t };
  } catch {
    return null;
  }
}

/** `res` kept in KV under `key` for twice `ttl` (KV's own expiry), once the answer is out. */
function toKv(ctx: CacheCtx, kv: AnswersKv, key: string, ttl: number, res: Response): void {
  const meta: KvMeta = { t: Date.now(), ct: res.headers.get('content-type'), cc: res.headers.get('cache-control'), etag: res.headers.get('etag') };
  ctx.waitUntil((async () => kv.put(await kvKey(key), await res.clone().text(), { expirationTtl: Math.max(60, ttl * 2), metadata: meta }))().catch(() => {}));
}

/** The stored answer for `key`, or `compute()`'s, stored for `ttl` seconds when
 *  it is a 200. Past `ttl` a stored answer is still served (STALE) for as long again
 *  while one fresh one is computed in the background. Adds an ETag (from the key,
 *  unless the handler set one) and answers 304 to a matching If-None-Match. Cache
 *  failures fall back to compute. */
export async function cached(
  ctx: CacheCtx,
  key: string,
  ttl: number,
  compute: () => Promise<Response>,
  cache: EdgeCache | null = defaultCache(),
  matchTimeoutMs = MATCH_TIMEOUT_MS,
): Promise<Response> {
  const kv = key.startsWith(ANSWER_PREFIX) ? (ctx.env as { ANSWERS?: AnswersKv } | undefined)?.ANSWERS : undefined;
  /** Keep a fresh answer everywhere it is kept. */
  const keepFresh = (res: Response) => {
    if (cache) store(ctx, cache, key, ttl, res);
    if (kv) toKv(ctx, kv, key, ttl, res);
  };
  /** Past ttl: one background refresh per key (its reads are not in this call's speed
   *  record: api-calls.ts recorded it when the answer went out). */
  const refreshIfStale = (madeAt: number): boolean => {
    const stale = madeAt > 0 && Date.now() - madeAt > ttl * 1000;
    for (const [k, at] of refreshing) if (Date.now() - at >= REFRESH_MS) refreshing.delete(k); // cut-off refreshes
    if (stale && !refreshing.has(key)) {
      refreshing.set(key, Date.now());
      ctx.waitUntil(compute()
        .then((fresh) => { if (fresh.status === 200 && !fresh.headers.has(NO_STORE)) keepFresh(withHeaders(fresh, { etag: fresh.headers.get('etag') ?? etagFor(key) })); })
        .catch(() => {})
        .finally(() => refreshing.delete(key)));
    }
    return stale;
  };

  const hit = cache ? await matchWithin(cache, key, matchTimeoutMs) : undefined;
  if (hit) {
    const stale = cache !== null && refreshIfStale(Number(hit.headers.get(STORED_AT)));
    return notModified(ctx.request, withHeaders(hit, {
      'cache-control': hit.headers.get(CLIENT_CC), [CLIENT_CC]: null, [STORED_AT]: null, 'x-edge-cache': stale ? 'STALE' : 'HIT',
    }));
  }
  const durable = kv ? await fromKv(kv, key, matchTimeoutMs) : null;
  if (durable) {
    if (cache) store(ctx, cache, key, ttl, durable.res, durable.at); // this data centre keeps it now
    const stale = refreshIfStale(durable.at);
    return notModified(ctx.request, withHeaders(durable.res, { 'x-edge-cache': stale ? 'STALE' : 'KV' }));
  }

  let res = await compute();
  if (res.status !== 200) return res;
  const keep = !res.headers.has(NO_STORE);
  res = withHeaders(res, { etag: res.headers.get('etag') ?? etagFor(key), 'x-edge-cache': 'MISS', [NO_STORE]: null });
  if (keep) keepFresh(res);
  return notModified(ctx.request, res);
}

/**
 * A D1-backed answer (counts, votes, the sitemap): kept `ttl` seconds in the
 * colo (default EDGE_TTL.live, so counts may lag a minute) instead of a D1 read
 * per request. The key is the URL alone (D1 does not change with a deploy). A
 * failure is a 503 the colo does not keep, never a cached "zero".
 */
export function cachedLive(
  ctx: CacheCtx,
  compute: () => Promise<Response>,
  ttl: number = EDGE_TTL.live,
  cache: EdgeCache | null = defaultCache(),
): Promise<Response> {
  return cached(ctx, cacheKey('live', new URL(ctx.request.url)), ttl, async () => {
    try {
      return await compute();
    } catch (e) {
      console.error(`${new URL(ctx.request.url).pathname} failed:`, (e as Error)?.message ?? e);
      return apiError(503, 'Temporarily unavailable, please try again', { 'retry-after': '30' });
    }
  }, cache);
}
