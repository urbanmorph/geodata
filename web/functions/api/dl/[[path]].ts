// GET /api/dl/<r2-key…>  — bumps a D1 counter then 302-redirects to R2.
// The counter increment is fire-and-forget via waitUntil so the redirect
// is never blocked on D1.

import type { Env } from '../_middleware';
import { classifyDownload, R2_PUBLIC_BASE as R2_BASE } from '../../lib/r2-keys';
import { loadCatalog } from '../../lib/catalog-loader';
import { incrementDownload } from '../../lib/counters';

type Params = { path: string[] };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const segs = (ctx.params.path as string[]) || [];
  const key = segs.join('/');
  if (!key) return new Response('missing key', { status: 400 });
  // Classify after answering: the redirect never waits on the catalog or D1.
  ctx.waitUntil(
    loadCatalog(new URL(ctx.request.url).origin)
      .then((catalog) => {
        const cls = classifyDownload(key, catalog);
        return cls ? incrementDownload(ctx.env.DB, cls.layer_id, cls.state_code, cls.format) : undefined;
      })
      .catch(() => {}),
  );
  return Response.redirect(`${R2_BASE}/${key}`, 302);
};
