// GET /api/dl/<r2-key…>  — bumps a D1 counter then 302-redirects to R2.
// The counter increment is fire-and-forget via waitUntil so the redirect
// is never blocked on D1.

import type { Env } from '../_middleware';
import { classifyDownload, R2_PUBLIC_BASE as R2_BASE } from '../../lib/r2-keys';
import { loadCatalog } from '../../lib/catalog-loader';
import { incrementDownload } from '../../lib/counters';
import { apiError } from '../../lib/http';
import { isNotCounted } from '../../lib/usage';

type Params = { path: string[] };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const segs = (ctx.params.path as string[]) || [];
  const key = segs.join('/');
  if (!key) return apiError(400, 'missing key');
  const location = `${R2_BASE}/${key}`;
  // Crawlers and link checkers follow download links too: not downloads.
  if (isNotCounted(ctx.request.headers.get('user-agent'))) return Response.redirect(location, 302);
  // Classify after answering: the redirect never waits on the catalog or D1.
  ctx.waitUntil(
    loadCatalog(ctx)
      .then((catalog) => {
        const cls = classifyDownload(key, catalog);
        return cls ? incrementDownload(ctx.env.DB, cls.layer_id, cls.state_code, cls.format) : undefined;
      })
      .catch(() => {}),
  );
  return Response.redirect(location, 302);
};
