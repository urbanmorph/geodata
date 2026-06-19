// GET /api/v1/layers/{id}/locate?lat=..&lng=..[&mode=auto|contains|nearest]
//
// "Locate me in this layer." Geometry-branched:
//   contains  — point-in-polygon over the layer's PMTiles (reuses lib/locate)
//   nearest   — closest feature + distance + bearing (reuses lib/nearby)
//   auto      — try contains (if the layer has pmtiles), else/empty -> nearest.
//
// The web client passes an explicit `mode` from the per-layer locate config
// (polygon layers = contains, line/point = nearest); `auto` is the convenience
// default for API/MCP callers who don't know the geometry. The result is
// location-specific + privacy-sensitive, so it is never cached.

import type { Env } from '../../../_middleware';
import { loadCatalog } from '../../../../lib/catalog-loader';
import { locate } from '../../../../lib/locate';
import { nearby } from '../../../../lib/nearby';
import { pickContains, bearingLabel } from '../../../../lib/locate-layer';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const id = (ctx.params as { id: string }).id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return json(400, { error: 'Invalid layer ID', status: 400 });
  }

  const url = new URL(ctx.request.url);
  const lat = parseFloat(url.searchParams.get('lat') || '');
  const lng = parseFloat(url.searchParams.get('lng') || '');
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return json(400, { error: 'lat and lng query params are required', status: 400 });
  }
  if (lat < 6 || lat > 38 || lng < 68 || lng > 98) {
    return json(400, { error: 'lat must be 6-38, lng must be 68-98 (India bounding box)', status: 400 });
  }

  const mode = (url.searchParams.get('mode') || 'auto') as 'auto' | 'contains' | 'nearest';
  const zoom = Math.min(Math.max(parseInt(url.searchParams.get('zoom') || '14', 10), 4), 16);
  const radiusKm = Math.min(Math.max(parseFloat(url.searchParams.get('radius_km') || '25'), 1), 200);

  const catalog = await loadCatalog(url.origin);
  const layer = catalog.layers.find((l) => l.id === id);
  if (!layer) return json(404, { error: 'Layer not found', status: 404 });

  const base = { layer_id: id, point: { lat, lng } };

  // CONTAINS — point-in-polygon. Tried unless the caller forced nearest.
  if (mode !== 'nearest' && layer.pmtiles) {
    try {
      const resp = await locate(lat, lng, [id], zoom, catalog, ctx.env.R2);
      const feature = pickContains(resp, id);
      // A hit ends it. A miss ends it too when contains was explicit (so the UI
      // can say "outside this layer's area" rather than jumping to a far-away
      // nearest); in `auto` a miss falls through to nearest below.
      if (feature || mode === 'contains') {
        return ok({ ...base, mode: 'contains', feature });
      }
    } catch (e) {
      if (mode === 'contains') return json(500, { error: (e as Error).message, status: 500 });
      // auto: fall through to nearest
    }
  }

  // NEAREST — closest feature within radius, with distance + compass bearing.
  if (mode !== 'contains' && layer.parquet) {
    try {
      const r = await nearby(lat, lng, radiusKm, id, catalog, ctx.env.R2, 1);
      const f = r.features[0];
      if (!f) {
        return ok({ ...base, mode: 'nearest', feature: null, out_of_coverage: true, searched_radius_km: radiusKm });
      }
      return ok({
        ...base,
        mode: 'nearest',
        feature: { properties: f.properties },
        distance_km: f._distance_km,
        bearing: bearingLabel(lat, lng, f._lat, f._lng),
      });
    } catch (e) {
      return json(400, { error: (e as Error).message, status: 400 });
    }
  }

  // mode=contains with no pmtiles, mode=nearest with no parquet, or auto with
  // neither queryable surface: nothing to locate against.
  return ok({ ...base, mode: mode === 'auto' ? 'contains' : mode, feature: null });
};

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
