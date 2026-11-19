import type { Env } from '../_middleware';
import { apiLimitFor } from '../../lib/api-ratelimit';

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  // The limit never waits on D1: the isolate decides, D1 follows in waitUntil
  // (lib/api-ratelimit.ts).
  const rl = await apiLimitFor(ctx.request, ctx.env, url.pathname.endsWith('/locate'), (p) => ctx.waitUntil(p));
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded', retryAfter: rl.retryAfter, status: 429 }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(rl.retryAfter),
        'x-api-version': 'v1',
      },
    });
  }

  const resp = await ctx.next();
  const headers = new Headers(resp.headers);
  headers.set('x-api-version', 'v1');
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(resp.body, { status: resp.status, headers });
};
