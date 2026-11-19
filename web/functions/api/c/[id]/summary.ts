// GET /api/c/:id/summary — public metadata for an accepted submission.
// Used by the /preview "Your submissions" panel to (1) refresh stale names
// after an edit, and (2) verify a paste-back URL before adding it locally.

import type { Env } from '../../_middleware';
import { getSubmissionForView } from '../../../lib/submissions';
import { SUBMISSION_ID } from '../../../lib/submissions-sql';
import { json } from '../../../lib/http';

type Params = { id: string };

const notFound = () => json(404, { error: 'not found' });

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!SUBMISSION_ID.test(id)) return notFound();

  const row = await getSubmissionForView(ctx.env.DB, id);
  if (!row) return notFound();

  return json(
    200,
    { id: row.id, name: row.name, status: row.status, created_at: row.created_at },
    { 'cache-control': 'public, max-age=30, stale-while-revalidate=300' },
  );
};
