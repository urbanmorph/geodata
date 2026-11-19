// The checks every /api/v1 call that names a layer makes first: the id is
// well formed, a retired id answers 301 to its successor, the layer exists.
// Also the India point check shared by locate and nearby.
import { loadCatalogVersioned, type AssetCtx } from './catalog-loader';
import type { CatalogData, CatalogLayer } from './catalog-api';
import { retiredRedirect } from './retired-layers';
import { apiError } from './http';

export const LAYER_ID = /^[a-zA-Z0-9_-]+$/;

export type ResolvedLayer = { layer: CatalogLayer; catalog: CatalogData; version: string; url: URL };

/**
 * The layer a request names, or the response to send instead: 400 for a
 * malformed id, 301 for a retired one (same URL, successor id), 404 for an
 * unknown one. `param` names a query parameter holding the id (/nearby?layer=);
 * without it the id is the route's {id}. `missingStatus` keeps an endpoint's
 * documented status for an unknown id (/nearby has always said 400).
 */
export async function resolveLayer(
  ctx: AssetCtx & { params?: unknown },
  opts: { param?: string; missingStatus?: number } = {},
): Promise<ResolvedLayer | Response> {
  const url = new URL(ctx.request.url);
  const id = opts.param ? url.searchParams.get(opts.param) ?? '' : String((ctx.params as { id?: string })?.id ?? '');
  if (!LAYER_ID.test(id)) return apiError(400, 'Invalid layer ID');
  const moved = retiredRedirect(url, id, opts.param);
  if (moved) return moved;
  const { catalog, version } = await loadCatalogVersioned(ctx);
  const layer = catalog.layers.find((l) => l.id === id);
  if (!layer) return apiError(opts.missingStatus ?? 404, `Layer ${id} not found`);
  return { layer, catalog, version, url };
}

/** India's bounding box, as the API checks it. */
const INDIA = { latMin: 6, latMax: 38, lngMin: 68, lngMax: 98 };

/** lat and lng from the query, inside India's bounding box, or the error to answer with. */
export function parseIndiaPoint(sp: URLSearchParams): { lat: number; lng: number } | { error: string } {
  const lat = parseFloat(sp.get('lat') ?? '');
  const lng = parseFloat(sp.get('lng') ?? '');
  if (Number.isNaN(lat) || Number.isNaN(lng)) return { error: 'lat and lng query params are required' };
  if (lat < INDIA.latMin || lat > INDIA.latMax || lng < INDIA.lngMin || lng > INDIA.lngMax) {
    return { error: 'lat must be 6-38, lng must be 68-98 (India bounding box)' };
  }
  return { lat, lng };
}
