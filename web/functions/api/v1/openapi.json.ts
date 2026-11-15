// GET /api/v1/openapi.json: the OpenAPI 3.1 description of this API
// (functions/lib/openapi.ts). Before this route existed the path fell through
// to the site's HTML.
import { OPENAPI } from '../../lib/openapi';

const BODY = JSON.stringify(OPENAPI, null, 2);

export const onRequestGet: PagesFunction = async () =>
  new Response(BODY, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
