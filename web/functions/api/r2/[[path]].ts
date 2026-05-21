// GET /api/r2/<key…> — stream the R2 object as a same-origin response.
//
// Used for "view on map" links from /c/[id] and any other place we want to
// hand a community-submitted file to /verify. The /api/dl/* endpoint 302s
// to the public R2 URL — fine for curated files that genuinely live there,
// useless for locally-submitted community files in dev. This endpoint reads
// from env.R2 directly so the same code path works in miniflare and in
// production.

import type { Env } from '../_middleware';

type Params = { path: string[] };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const segs = (ctx.params.path as string[]) || [];
  const key = segs.join('/');
  if (!key) return new Response('missing key', { status: 400 });

  const obj = await ctx.env.R2.get(key);
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400');
  // Same origin in practice (we mount this under /api), but tag CORS just in
  // case future tools fetch it from a different host.
  headers.set('access-control-allow-origin', '*');

  return new Response(obj.body, { headers });
};
