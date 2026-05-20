// POST /api/c/:id/rate — anonymous thumbs-up (one per IP per submission).
// Skeleton — wired up in checkpoint #28 alongside the download counter.

import type { Env } from '../../_middleware';

type Params = { id: string };

export const onRequestPost: PagesFunction<Env, keyof Params> = async () =>
  new Response(JSON.stringify({ error: 'not implemented' }), { status: 501, headers: { 'content-type': 'application/json' } });
