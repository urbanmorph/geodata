// GET /api/c/:id/summary — public metadata for an accepted submission.
// Used by the /preview "Your submissions" panel to (1) refresh stale names
// after an edit, and (2) verify a paste-back URL before adding it locally.

import type { Env } from '../../_middleware';
import { getSubmissionForView } from '../../../lib/submissions';

type Params = { id: string };

const notFound = () => new Response(
  JSON.stringify({ error: 'not found' }),
  { status: 404, headers: { 'content-type': 'application/json' } },
);

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!/^[A-Za-z0-9_-]{8,16}$/.test(id)) return notFound();

  const row = await getSubmissionForView(ctx.env.DB, id);
  if (!row) return notFound();

  return new Response(
    JSON.stringify({
      id: row.id,
      name: row.name,
      status: row.status,
      created_at: row.created_at,
    }),
    {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=30, stale-while-revalidate=300',
      },
    },
  );
};
