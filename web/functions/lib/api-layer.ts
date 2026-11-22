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
 * The shared lookup behind every route that names a curated layer (/api/v1,
 * /view, /og/view): the id is well formed, a retired id answers 301, then the
 * catalog lookup. Each caller turns `invalid` and `missing` into its own error
 * response. A catalog that fails to load rejects; the caller decides on that too.
 */
export type LayerLookup =
  | ({ kind: 'found' } & ResolvedLayer)
  | { kind: 'invalid' }
  | { kind: 'moved'; response: Response }
  | { kind: 'missing'; catalog: CatalogData };

export async function findLayer(ctx: AssetCtx, id: string, url: URL, param?: string): Promise<LayerLookup> {
  if (!LAYER_ID.test(id)) return { kind: 'invalid' };
  const moved = retiredRedirect(url, id, param);
  if (moved) return { kind: 'moved', response: moved };
  const { catalog, version } = await loadCatalogVersioned(ctx);
  const layer = catalog.layers.find((l) => l.id === id);
  return layer ? { kind: 'found', layer, catalog, version, url } : { kind: 'missing', catalog };
}

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
  const found = await findLayer(ctx, id, url, opts.param);
  switch (found.kind) {
    case 'invalid': return apiError(400, 'Invalid layer ID');
    case 'moved': return found.response;
    case 'missing': return apiError(opts.missingStatus ?? 404, `Layer ${id} not found`);
    default: return { layer: found.layer, catalog: found.catalog, version: found.version, url };
  }
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
