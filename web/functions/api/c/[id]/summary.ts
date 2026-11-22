// GET /api/c/:id/summary — public metadata for an accepted submission.
// Used by the /preview "Your submissions" panel to (1) refresh stale names
// after an edit, and (2) verify a paste-back URL before adding it locally.

import type { Env } from '../../_middleware';
import { acceptedSubmission } from '../../../lib/submissions';
import { json } from '../../../lib/http';

type Params = { id: string };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const row = await acceptedSubmission(ctx.env.DB, ctx.params.id as string);
  if (!row) return json(404, { error: 'not found' });

  return json(
    200,
    { id: row.id, name: row.name, status: row.status, created_at: row.created_at },
    { 'cache-control': 'public, max-age=30, stale-while-revalidate=300' },
  );
};
