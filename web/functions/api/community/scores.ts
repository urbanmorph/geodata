// GET /api/community/scores — returns up/down/score for every accepted
// submission. The home page hydrates the community cards from this on
// load so votes appear live without waiting for the next prerender.

import type { Env } from '../_middleware';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const r = await ctx.env.DB.prepare(
    `SELECT s.id,
            COALESCE(SUM(CASE WHEN r.vote = 1 THEN 1 ELSE 0 END), 0) AS up,
            COALESCE(SUM(CASE WHEN r.vote = -1 THEN 1 ELSE 0 END), 0) AS down
     FROM submissions s
     LEFT JOIN submission_ratings r ON r.submission_id = s.id
     WHERE s.status = 'accepted'
     GROUP BY s.id`,
  ).all();
  const rows = (r.results || []) as Array<{ id: string; up: number; down: number }>;
  return new Response(JSON.stringify(rows), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30, stale-while-revalidate=120',
    },
  });
};
