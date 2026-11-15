import { notFoundForUnmatched } from '../lib/api-not-found';
import { SECURITY_HEADERS_NON_HTML } from '../lib/security-headers';

// CORS preflight + shared environment shape.
// Pages Functions read this from each /api/* handler via the `data` arg.

export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  TURNSTILE_SECRET?: string;
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      },
    });
  }
  const resp = notFoundForUnmatched(await ctx.next(), new URL(ctx.request.url).pathname);
  // CORS, plus the shared security headers (nosniff, HSTS, ...) where the
  // handler didn't set its own.
  const headers = new Headers(resp.headers);
  headers.set('access-control-allow-origin', '*');
  for (const [k, v] of Object.entries(SECURITY_HEADERS_NON_HTML)) if (!headers.has(k)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
};
