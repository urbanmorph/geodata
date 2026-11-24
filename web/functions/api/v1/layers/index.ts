import type { Env } from '../../_middleware';
import { loadCatalogVersioned } from '../../../lib/catalog-loader';
import { filterLayers, paginateResults, toApiLayer, type ApiLayer } from '../../../lib/catalog-api';
import { answerKey, cached, CACHE_CONTROL, EDGE_TTL } from '../../../lib/edge-cache';
import { apiError, json } from '../../../lib/http';
import { withLookups } from '../../../lib/lookups';
import { pointProfilesOn } from '../../../lib/point-profiles';
import { REALM_IDS } from '../../../../../shared/realms.mjs';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const realm = url.searchParams.get('realm') || undefined;
  if (realm && !REALM_IDS.includes(realm)) return apiError(400, `Unknown realm "${realm}". Valid realms: ${REALM_IDS.join(', ')}.`);
  // Which lookup reads each layer, said only while the lookups are published.
  const shape: (l: ApiLayer) => ApiLayer = pointProfilesOn(ctx.env, url) ? withLookups : (l) => l;
  const { catalog, dataVersion } = await loadCatalogVersioned(ctx);
  const identity = `${dataVersion}${shape === withLookups ? '.lookups' : ''}`;

  return cached(ctx, answerKey('layers', identity, url), EDGE_TTL.catalog, async () => {
    const filtered = filterLayers(catalog.layers, {
      category: url.searchParams.get('category') || undefined,
      level: url.searchParams.get('level') || undefined,
      source: url.searchParams.get('source') || undefined,
      realm,
      q: url.searchParams.get('q') || undefined,
    });

    const page = paginateResults(
      filtered.map((l) => shape(toApiLayer(l, catalog))),
      {
        limit: Number(url.searchParams.get('limit')) || undefined,
        offset: Number(url.searchParams.get('offset')) || undefined,
      },
    );

    return json(200, page, { 'cache-control': CACHE_CONTROL.catalog });
  });
};
