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
import { locate } from '../../../../lib/locate';
import { nearby } from '../../../../lib/nearby';
import { QueryInputError } from '../../../../lib/parquet-query';
import { pickContains, bearingLabel } from '../../../../lib/locate-layer';
import { apiError, json, serverError } from '../../../../lib/http';
import { countApiUse } from '../../../../lib/usage';
import { clampNum } from '../../../../lib/query-params';
import { parseIndiaPoint, resolveLayer } from '../../../../lib/api-layer';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const pt = parseIndiaPoint(url.searchParams);
  if ('error' in pt) return apiError(400, pt.error);
  const { lat, lng } = pt;

  // clampNum turns NaN into the default: radius_km=x made the bbox NaN, and NaN
  // comparisons matched every row group, so the whole layer was read.
  const mode = url.searchParams.get('mode') || 'auto';
  if (mode !== 'auto' && mode !== 'contains' && mode !== 'nearest') {
    return apiError(400, 'mode must be auto, contains or nearest');
  }
  const zoom = clampNum(url.searchParams.get('zoom'), 14, 4, 16, true);
  const radiusKm = clampNum(url.searchParams.get('radius_km'), 25, 1, 200);

  const r = await resolveLayer(ctx);
  if (r instanceof Response) return r;
  const { layer, catalog } = r;
  const id = layer.id;
  countApiUse(ctx, id);

  const base = { layer_id: id, point: { lat, lng } };

  // CONTAINS — point-in-polygon. Tried unless the caller forced nearest.
  if (mode !== 'nearest' && layer.pmtiles) {
    const resp = await locate(lat, lng, [id], zoom, catalog, ctx.env.R2);
    // A layer that couldn't be read says nothing about the point: explicit
    // contains is a 500 (not "outside this layer's area"); auto tries nearest.
    if (resp.failed_layers?.includes(id)) {
      if (mode === 'contains') return serverError('Locate', new Error(`${id}: tiles could not be read`));
    } else {
      const feature = pickContains(resp, id);
      // A hit ends it. A miss ends it too when contains was explicit (so the UI
      // can say "outside this layer's area" rather than jumping to a far-away
      // nearest); in `auto` a miss falls through to nearest below.
      if (feature || mode === 'contains') {
        return ok({ ...base, mode: 'contains', feature });
      }
    }
  }

  // NEAREST — closest feature within radius, with distance + compass bearing.
  if (mode !== 'contains' && layer.parquet) {
    try {
      const n = await nearby(lat, lng, radiusKm, id, catalog, ctx.env.R2, 1);
      const f = n.features[0];
      if (!f) {
        return ok({ ...base, mode: 'nearest', feature: null, out_of_coverage: true, searched_radius_km: radiusKm });
      }
      return ok({
        ...base,
        mode: 'nearest',
        feature: { properties: f.properties },
        feature_point: { lat: f._lat, lng: f._lng }, // so the client can zoom to it
        distance_km: f._distance_km,
        bearing: bearingLabel(lat, lng, f._lat, f._lng),
      });
    } catch (e) {
      if (e instanceof QueryInputError) return apiError(400, e.message);
      return serverError('Locate', e);
    }
  }

  // mode=contains with no pmtiles, mode=nearest with no parquet, or auto with
  // neither queryable surface: nothing to locate against.
  return ok({ ...base, mode: mode === 'auto' ? 'contains' : mode, feature: null });
};

const ok = (body: unknown) => json(200, body, { 'cache-control': 'private, no-store' });
