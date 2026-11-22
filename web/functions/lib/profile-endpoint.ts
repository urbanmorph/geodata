// The HTTP side of a point profile (/api/v1/ground, /api/v1/surface): unpublished
// (a plain 404) unless POINT_PROFILES is on; the point checked and snapped to about
// 100 m; the call counted (usage.ts, endpoint:<name>); the answer computed by
// lib/profile.ts and kept in the colo's cache under the snapped point, the option
// and the rasters' versions, unless a layer was missed by chance (a timeout or a
// failed read). Clients are told not to store it (a point is personal).
// R2 reads go through the colo's cache (colo-cache.ts), so a fresh isolate does not
// read every layer's metadata again; x-profile-reads, x-profile-colo-hits and
// server-timing (catalog, lookup, profile, between the middlewares' limit and api:
// lib/server-timing.ts, which also says what the Workers clock leaves out) say where an
// answer's time went.
import type { Env } from '../api/_middleware';
import { loadCatalogVersioned } from './catalog-loader';
import { partialByChance, snapPoint, SNAP_DECIMALS, type ProfileOpts, type ProfileResponse } from './profile';
import type { CatalogData } from './catalog-api';
import { apiError, json, serverError } from './http';
import { parseIndiaPoint } from './api-layer';
import { cached, cacheKey, defaultCache, EDGE_TTL, NO_STORE } from './edge-cache';
import { coloBucket, coloCache } from './colo-cache';
import { notPublished, pointProfilesOn } from './point-profiles';
import { countApiUse, endpointUsageId } from './usage';
import { timing } from './server-timing';

export type ProfileRun = (lat: number, lng: number, catalog: CatalogData, r2: R2Bucket, opts: ProfileOpts) => Promise<ProfileResponse>;

/** The bucket, counting its reads (get and head): every read waits for one of the
 *  Worker's six connections, so the count is what sets an answer's latency. */
export function countingBucket(r2: R2Bucket): { bucket: R2Bucket; reads: () => number } {
  let n = 0;
  const bucket = new Proxy(r2, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if ((prop === 'get' || prop === 'head') && typeof v === 'function') {
        return (...args: unknown[]) => { n++; return v.apply(target, args); };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { bucket, reads: () => n };
}

/** `run` as a GET handler for /api/v1/<name>. `version` names what the catalog does not (e.g. raster files), for the cache key. */
export function profileHandler(name: string, run: ProfileRun, version: string): PagesFunction<Env> {
  const label = name[0].toUpperCase() + name.slice(1);
  return async (ctx) => {
    const url = new URL(ctx.request.url);
    if (!pointProfilesOn(ctx.env, url)) return notPublished(url.pathname);
    const pt = parseIndiaPoint(url.searchParams);
    if ('error' in pt) return apiError(400, pt.error);
    countApiUse(ctx, endpointUsageId(name));
    const openOnly = url.searchParams.get('open_only') === 'true';
    const { lat, lng } = snapPoint(pt.lat, pt.lng);
    try {
      const t0 = Date.now();
      const { catalog, version: catalogVersion } = await loadCatalogVersioned(ctx);
      const tCatalog = Date.now();
      let tRun: number | undefined;
      const keyUrl = new URL(url.origin + url.pathname);
      keyUrl.searchParams.set('lat', lat.toFixed(SNAP_DECIMALS));
      keyUrl.searchParams.set('lng', lng.toFixed(SNAP_DECIMALS));
      if (openOnly) keyUrl.searchParams.set('open_only', 'true');
      keyUrl.searchParams.set('v', version);
      const res = await cached(ctx, cacheKey(catalogVersion, keyUrl), EDGE_TTL.r2, async () => {
        tRun = Date.now();
        const { bucket, reads } = countingBucket(ctx.env.R2);
        const colo = coloCache(defaultCache(), (p) => ctx.waitUntil(p));
        let profile: ProfileResponse;
        try {
          profile = await run(lat, lng, catalog, coloBucket(bucket, colo, catalogVersion), { openOnly, waitUntil: (p) => ctx.waitUntil(p) });
        } finally {
          colo.startPuts(); // the answer is done: what it read for the next isolate, without slowing this one
        }
        return json(200, profile, {
          'cache-control': 'private, no-store',
          'x-profile-reads': String(reads()),
          'x-profile-colo-hits': String(colo.hits()),
          ...(partialByChance(profile) ? { [NO_STORE]: '1' } : {}),
        });
      });
      // Where the time went, for this request (never the stored copy's): the catalog, the
      // edge cache lookup, and the profile itself when it ran.
      const tEnd = Date.now();
      const phases = [timing('catalog', tCatalog - t0), timing('lookup', (tRun ?? tEnd) - tCatalog), ...(tRun ? [timing('profile', tEnd - tRun)] : [])];
      const out = new Response(res.body, res);
      out.headers.set('server-timing', phases.join(', '));
      return out;
    } catch (e) {
      return serverError(label, e);
    }
  };
}
