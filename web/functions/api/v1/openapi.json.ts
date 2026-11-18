// GET /api/v1/openapi.json: the OpenAPI 3.1 description of this API
// (functions/lib/openapi.ts). Before this route existed the path fell through
// to the site's HTML. A constant built at load: an ETag (and 304) is all the
// caching it needs.
import { OPENAPI } from '../../lib/openapi';
import { etagFor, notModified } from '../../lib/edge-cache';

const BODY = JSON.stringify(OPENAPI, null, 2);
const ETAG = etagFor(BODY);

export const onRequestGet: PagesFunction = async (ctx) =>
  notModified(ctx.request, new Response(BODY, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
      etag: ETAG,
    },
  }));
