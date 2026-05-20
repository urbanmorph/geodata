// POST /api/c/:id/rate — anonymous thumbs-up. Idempotent per (submission, IP).

import type { Env as MiddlewareEnv } from '../../_middleware';
import { getSubmissionForView } from '../../../lib/submissions';
import { recordRating } from '../../../lib/ratings';
import { ipHashFor } from '../../../lib/submit-helpers';

type Env = MiddlewareEnv & { IP_SALT?: string };
type Params = { id: string };

const j = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const onRequestPost: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;

  if (!/^[A-Za-z0-9_-]{8,16}$/.test(id)) return j(404, { error: 'not found' });

  const sub = await getSubmissionForView(ctx.env.DB, id);
  if (!sub) return j(404, { error: 'not found' });

  const ipHash = await ipHashFor(ctx.request, ctx.env.IP_SALT || 'geodata-v1');
  const { alreadyRated, count } = await recordRating(ctx.env.DB, id, ipHash);

  return j(200, { count, alreadyRated });
};
