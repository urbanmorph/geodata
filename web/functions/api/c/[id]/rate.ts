// /api/c/:id/rate — anonymous single-direction "Useful" voting.
//   GET  → { up, down, score, myVote } for this IP (down stays for back-
//         compat reads of pre-existing rows; new writes can't add down).
//   POST { vote: 1 | 0 } → records or clears the "Useful" mark.
// (submission_id, ip_hash) is the primary key, so votes are idempotent
// and reversible per IP. Downvote previously existed but was retired
// (brigading risk on an open-contribution platform with no moderation
// team) — see task #61 for the migration rationale.

import type { Env } from '../../_middleware';
import { getSubmissionForView } from '../../../lib/submissions';
import { SUBMISSION_ID } from '../../../lib/submissions-sql';
import { recordVote, countVotes, getMyVote, type Vote } from '../../../lib/ratings';
import { ipHashStable, ipSalt } from '../../../lib/submit-helpers';
import { json as j } from '../../../lib/http';

type Params = { id: string };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!SUBMISSION_ID.test(id)) return j(404, { error: 'not found' });
  const sub = await getSubmissionForView(ctx.env.DB, id);
  if (!sub) return j(404, { error: 'not found' });
  const ipHash = await ipHashStable(ctx.request, ipSalt(ctx.env.IP_SALT, 'geodata-v1'));
  const [tally, myVote] = await Promise.all([
    countVotes(ctx.env.DB, id),
    getMyVote(ctx.env.DB, id, ipHash),
  ]);
  return j(200, { ...tally, myVote });
};

export const onRequestPost: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!SUBMISSION_ID.test(id)) return j(404, { error: 'not found' });

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

  const ipHash = await ipHashStable(ctx.request, ipSalt(ctx.env.IP_SALT, 'geodata-v1'));
  const result = await recordVote(ctx.env.DB, id, ipHash, vote as Vote);
  return j(200, result);
};
