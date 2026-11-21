// The HTTP side of a point profile (/api/v1/ground, /api/v1/surface): unpublished
// (a plain 404) unless POINT_PROFILES is on; the point checked and snapped to about
// 100 m; the answer computed by lib/profile.ts and kept in the colo's cache under the
// snapped point, the option and the rasters' versions, unless a layer was missed by
// chance (a timeout or a failed read). Clients are told not to store it (a point is personal).
import type { Env } from '../api/_middleware';
import { loadCatalogVersioned } from './catalog-loader';
import { partialByChance, snapPoint, SNAP_DECIMALS, type ProfileOpts, type ProfileResponse } from './profile';
import type { CatalogData } from './catalog-api';
import { apiError, json, serverError } from './http';
import { parseIndiaPoint } from './api-layer';
import { cached, cacheKey, EDGE_TTL, NO_STORE } from './edge-cache';
import { notPublished, pointProfilesOn } from './point-profiles';

export type ProfileRun = (lat: number, lng: number, catalog: CatalogData, r2: R2Bucket, opts: ProfileOpts) => Promise<ProfileResponse>;

/** `run` as a GET handler. `version` names what the catalog does not (e.g. raster files), for the cache key. */
export function profileHandler(name: string, run: ProfileRun, version: string): PagesFunction<Env> {
  return async (ctx) => {
    const url = new URL(ctx.request.url);
    if (!pointProfilesOn(ctx.env, url)) return notPublished(url.pathname);
    const pt = parseIndiaPoint(url.searchParams);
    if ('error' in pt) return apiError(400, pt.error);
    const openOnly = url.searchParams.get('open_only') === 'true';
    const { lat, lng } = snapPoint(pt.lat, pt.lng);
    try {
      const { catalog, version: catalogVersion } = await loadCatalogVersioned(ctx);
      const keyUrl = new URL(url.origin + url.pathname);
      keyUrl.searchParams.set('lat', lat.toFixed(SNAP_DECIMALS));
      keyUrl.searchParams.set('lng', lng.toFixed(SNAP_DECIMALS));
      if (openOnly) keyUrl.searchParams.set('open_only', 'true');
      keyUrl.searchParams.set('v', version);
      return await cached(ctx, cacheKey(catalogVersion, keyUrl), EDGE_TTL.r2, async () => {
        const profile = await run(lat, lng, catalog, ctx.env.R2, { openOnly, waitUntil: (p) => ctx.waitUntil(p) });
        return json(200, profile, {
          'cache-control': 'private, no-store',
          ...(partialByChance(profile) ? { [NO_STORE]: '1' } : {}),
        });
      });
    } catch (e) {
      return serverError(name, e);
    }
  };
}
