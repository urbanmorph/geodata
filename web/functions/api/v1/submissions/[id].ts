import type { Env } from '../../_middleware';
import { SUBMISSION_DETAIL_SQL, SUBMISSION_ID } from '../../../lib/submissions-sql';
import { apiError, json } from '../../../lib/http';

type Params = { id: string };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!SUBMISSION_ID.test(id)) {
    return apiError(400, 'Invalid submission ID');
  }

  const row = await ctx.env.DB.prepare(SUBMISSION_DETAIL_SQL).bind(id).first();

  if (!row) return apiError(404, 'Submission not found');

  return json(200, { data: row }, { 'cache-control': 'public, max-age=30, stale-while-revalidate=300' });
};
