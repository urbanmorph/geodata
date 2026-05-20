// POST /api/submit — accept a file + metadata, return token + URL.
// Skeleton: the auto-moderator (lib/validate.ts) + Turnstile verification
// land in checkpoint #29. This endpoint returns 501 until then.

import type { Env } from './_middleware';

export const onRequestPost: PagesFunction<Env> = async () =>
  new Response(JSON.stringify({ error: 'not implemented', phase: 'v3.1' }), {
    status: 501,
    headers: { 'content-type': 'application/json' },
  });

export const onRequest: PagesFunction<Env> = async () =>
  new Response('method not allowed', { status: 405 });
