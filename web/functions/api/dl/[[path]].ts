// GET /api/dl/<r2-key…>  — bumps a D1 counter then 302-redirects to R2.
// Skeleton — counter increment lands in checkpoint #28.

import type { Env } from '../_middleware';

type Params = { path: string[] };

const R2_BASE = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev';

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const segs = (ctx.params.path as string[]) || [];
  const key = segs.join('/');
  if (!key) return new Response('missing key', { status: 400 });
  // TODO #28: increment download_counts(layer_id, state_code, format) here.
  return Response.redirect(`${R2_BASE}/${key}`, 302);
};
