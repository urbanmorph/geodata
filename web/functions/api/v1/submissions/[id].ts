import type { Env } from '../../_middleware';
import { SUBMISSION_DETAIL_SQL } from '../../../lib/submissions-sql';
import { json } from '../../../lib/http';

type Params = { id: string };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return json(400, { error: 'Invalid submission ID', status: 400 });
  }

  const row = await ctx.env.DB.prepare(SUBMISSION_DETAIL_SQL).bind(id).first();

  if (!row) return json(404, { error: 'Submission not found', status: 404 });

  return new Response(JSON.stringify({ data: row }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30, stale-while-revalidate=300',
    },
  });
};
