// GET /api/v1/ground?lat=..&lng=..[&open_only=true]: what is below a point
// (seismic zone and faults, rock and landform, resources, aquifer and
// groundwater, soil, subsidence, tunnels and buried utilities) in one call.
// lib/ground.ts holds the layer table and the runner. The answer is for the
// point snapped to about 100 m and is kept in the colo's cache under that
// point (only when every layer answered); clients are told not to store it.
import type { Env } from '../_middleware';
import { loadCatalogVersioned } from '../../lib/catalog-loader';
import { groundAt, snapPoint, SNAP_DECIMALS } from '../../lib/ground';
import { SOILGRIDS } from '../../lib/soilgrids';
import { apiError, json, serverError } from '../../lib/http';
import { parseIndiaPoint } from '../../lib/api-layer';
import { cached, cacheKey, EDGE_TTL, NO_STORE } from '../../lib/edge-cache';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const pt = parseIndiaPoint(url.searchParams);
  if ('error' in pt) return apiError(400, pt.error);
  const openOnly = url.searchParams.get('open_only') === 'true';
  const { lat, lng } = snapPoint(pt.lat, pt.lng);
  try {
    const { catalog, version } = await loadCatalogVersioned(ctx);
    // The key names the snapped point, the option, and the SoilGrids file (it is not in the catalog).
    const keyUrl = new URL(url.origin + url.pathname);
    keyUrl.searchParams.set('lat', lat.toFixed(SNAP_DECIMALS));
    keyUrl.searchParams.set('lng', lng.toFixed(SNAP_DECIMALS));
    if (openOnly) keyUrl.searchParams.set('open_only', 'true');
    const soil = (SOILGRIDS.file as { md5?: string } | null)?.md5?.slice(0, 8) ?? 'none';
    keyUrl.searchParams.set('soilgrids', soil);
    return await cached(ctx, cacheKey(version, keyUrl), EDGE_TTL.r2, async () => {
      const profile = await groundAt(lat, lng, catalog, ctx.env.R2, undefined, { openOnly, waitUntil: (p) => ctx.waitUntil(p) });
      return json(200, profile, {
        'cache-control': 'private, no-store',
        ...(profile.unavailable.length ? { [NO_STORE]: '1' } : {}),
      });
    });
  } catch (e) {
    return serverError('Ground', e);
  }
};
