// GET /api/dl/<r2-key…>  — bumps a D1 counter then 302-redirects to R2.
// The counter increment is fire-and-forget via waitUntil so the redirect
// is never blocked on D1.

import type { Env } from '../_middleware';
import { classifyKey } from '../../lib/r2-keys';
import { incrementDownload } from '../../lib/counters';

type Params = { path: string[] };

const R2_BASE = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev';

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const segs = (ctx.params.path as string[]) || [];
  const key = segs.join('/');
  if (!key) return new Response('missing key', { status: 400 });
  const cls = classifyKey(key);
  if (cls) {
    ctx.waitUntil(
      incrementDownload(ctx.env.DB, cls.layer_id, cls.state_code, cls.format).catch(() => {}),
    );
  }
  return Response.redirect(`${R2_BASE}/${key}`, 302);
};
