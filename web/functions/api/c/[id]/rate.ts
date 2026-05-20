// /api/c/:id/rate — anonymous up/down voting.
//   GET  → { up, down, score, myVote } for this IP (read-only).
//   POST { vote: 1 | -1 | 0 } → records / changes / clears the vote.
// (submission_id, ip_hash) is the primary key, so votes are idempotent
// and reversible per IP.

import type { Env as MiddlewareEnv } from '../../_middleware';
import { getSubmissionForView } from '../../../lib/submissions';
import { recordVote, countVotes, getMyVote, type Vote } from '../../../lib/ratings';
import { ipHashFor } from '../../../lib/submit-helpers';

type Env = MiddlewareEnv & { IP_SALT?: string };
type Params = { id: string };

const j = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const validId = (id: string) => /^[A-Za-z0-9_-]{8,16}$/.test(id);

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!validId(id)) return j(404, { error: 'not found' });
  const sub = await getSubmissionForView(ctx.env.DB, id);
  if (!sub) return j(404, { error: 'not found' });
  const ipHash = await ipHashFor(ctx.request, ctx.env.IP_SALT || 'geodata-v1');
  const [tally, myVote] = await Promise.all([
    countVotes(ctx.env.DB, id),
    getMyVote(ctx.env.DB, id, ipHash),
  ]);
  return j(200, { ...tally, myVote });
};

export const onRequestPost: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!validId(id)) return j(404, { error: 'not found' });

  let body: { vote?: unknown };
  try {
    body = (await ctx.request.json()) as { vote?: unknown };
  } catch {
    return j(400, { error: 'invalid JSON body' });
  }
  const vote = body.vote;
  if (vote !== 1 && vote !== -1 && vote !== 0) {
    return j(400, { error: 'vote must be 1, -1, or 0' });
  }

  const sub = await getSubmissionForView(ctx.env.DB, id);
  if (!sub) return j(404, { error: 'not found' });

  const ipHash = await ipHashFor(ctx.request, ctx.env.IP_SALT || 'geodata-v1');
  const result = await recordVote(ctx.env.DB, id, ipHash, vote as Vote);
  return j(200, result);
};
