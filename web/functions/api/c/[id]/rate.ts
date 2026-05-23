// /api/c/:id/rate — anonymous single-direction "Useful" voting.
//   GET  → { up, down, score, myVote } for this IP (down stays for back-
//         compat reads of pre-existing rows; new writes can't add down).
//   POST { vote: 1 | 0 } → records or clears the "Useful" mark.
// (submission_id, ip_hash) is the primary key, so votes are idempotent
// and reversible per IP. Downvote previously existed but was retired
// (brigading risk on an open-contribution platform with no moderation
// team) — see task #61 for the migration rationale.

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
  if (vote !== 1 && vote !== 0) {
    return j(400, { error: 'vote must be 1 (useful) or 0 (clear)' });
  }

  const sub = await getSubmissionForView(ctx.env.DB, id);
  if (!sub) return j(404, { error: 'not found' });

  const ipHash = await ipHashFor(ctx.request, ctx.env.IP_SALT || 'geodata-v1');
  const result = await recordVote(ctx.env.DB, id, ipHash, vote as Vote);
  return j(200, result);
};
