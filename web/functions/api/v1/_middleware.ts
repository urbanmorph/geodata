import type { Env } from '../_middleware';
import { checkApiRateLimit } from '../../lib/api-ratelimit';

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  // CF-Connecting-IP only — never trust X-Forwarded-For (attacker-controlled
  // header; a rotating XFF would let one client mint fresh rate-limit buckets).
  const ip = ctx.request.headers.get('cf-connecting-ip') || 'unknown';
  const ipHash = await sha256(ip);

  const isLocate = url.pathname.endsWith('/locate');
  const limit = isLocate ? 60 : 120;

  try {
    const rl = await checkApiRateLimit(ctx.env.DB, ipHash, limit);
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
  } catch {
    // D1 failure should not block reads
  }

  const resp = await ctx.next();
  const headers = new Headers(resp.headers);
  headers.set('x-api-version', 'v1');
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(resp.body, { status: resp.status, headers });
};

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
