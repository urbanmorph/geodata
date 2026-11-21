import { notFoundForUnmatched } from '../lib/api-not-found';
import { SECURITY_HEADERS_NON_HTML } from '../lib/security-headers';
import { serverError } from '../lib/http';

// CORS preflight + shared environment shape.
// Pages Functions read this from each /api/* handler via the `data` arg.

export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  ASSETS: Fetcher;     // Pages' static assets (e.g. /releases/index.json)
  TURNSTILE_SECRET?: string;
  IP_SALT?: string;    // salts hashed IPs (rate-limit keys); unsalted when absent
  POINT_PROFILES?: string; // "on" publishes /api/v1/ground and /surface (lib/point-profiles.ts)
};

const READS = new Set(['GET', 'HEAD']);

/** A write sent by a page on another site (a browser's Origin header). Scripts
 *  send no Origin; bharatlas's own pages send their own. */
function crossSiteWrite(req: Request): boolean {
  if (READS.has(req.method)) return false;
  const origin = req.headers.get('origin');
  return !!origin && origin !== new URL(req.url).origin;
}

// Other sites may read the API (CORS *), never write to it: a page elsewhere
// could otherwise make its visitors' browsers vote or submit (review 2026-11-18).
export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method === 'OPTIONS') {
    const wants = (ctx.request.headers.get('access-control-request-method') || 'GET').toUpperCase();
    if (!READS.has(wants)) return new Response(null, { status: 204 }); // no grant: the browser blocks the write
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      },
    });
  }
  if (crossSiteWrite(ctx.request)) {
    return new Response(JSON.stringify({ error: 'writes are only accepted from bharatlas.com', status: 403 }), {
      status: 403, headers: { 'content-type': 'application/json', ...SECURITY_HEADERS_NON_HTML },
    });
  }
  // A handler that throws would otherwise reach the caller as Cloudflare's HTML
  // error page (1101): every /api answer is JSON {error, status}.
  let resp: Response;
  try {
    resp = notFoundForUnmatched(await ctx.next(), new URL(ctx.request.url).pathname);
  } catch (e) {
    resp = serverError('Request', e);
  }
  // CORS for reads, plus the shared security headers (nosniff, HSTS, ...)
  // where the handler didn't set its own.
  const headers = new Headers(resp.headers);
  if (READS.has(ctx.request.method)) headers.set('access-control-allow-origin', '*');
  else headers.delete('access-control-allow-origin');
  for (const [k, v] of Object.entries(SECURITY_HEADERS_NON_HTML)) if (!headers.has(k)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
};
