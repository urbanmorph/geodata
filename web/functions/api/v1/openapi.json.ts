// GET /api/v1/openapi.json: the OpenAPI 3.1 description of this API
// (functions/lib/openapi.ts). Before this route existed the path fell through
// to the site's HTML. Built once per flag state: an ETag (and 304) is all the
// caching it needs. The point lookups appear only while POINT_PROFILES is on.
import { openapiFor } from '../../lib/openapi';
import { etagFor, notModified } from '../../lib/edge-cache';
import { pointProfilesOn } from '../../lib/point-profiles';

const bodies = new Map<boolean, { body: string; etag: string }>();
function bodyFor(on: boolean) {
  let b = bodies.get(on);
  if (!b) {
    const body = JSON.stringify(openapiFor(on), null, 2);
    b = { body, etag: etagFor(body) };
    bodies.set(on, b);
  }
  return b;
}

export const onRequestGet: PagesFunction<{ POINT_PROFILES?: string }> = async (ctx) => {
  const { body, etag } = bodyFor(pointProfilesOn(ctx.env, new URL(ctx.request.url)));
  return notModified(ctx.request, new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
      etag,
    },
  }));
};
