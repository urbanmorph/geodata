import type { Env } from '../../_middleware';
import { json } from '../../../lib/http';
import { clampNum } from '../../../lib/query-params';
import { containsPattern, SEARCH_WHERE, submissionCountSql, submissionListSql, type SubmissionSort } from '../../../lib/submissions-sql';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const limit = clampNum(url.searchParams.get('limit'), 20, 1, 100, true);
  const offset = clampNum(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER, true);
  const sort: SubmissionSort = url.searchParams.get('sort') === 'useful' ? 'useful' : 'newest';
  const category = url.searchParams.get('category');
  const q = url.searchParams.get('q');

  let where = "status = 'accepted'";
  const binds: unknown[] = [];

  if (category) {
    where += ' AND category = ?';
    binds.push(category);
  }
  if (q) {
    where += SEARCH_WHERE;
    binds.push(containsPattern(q), containsPattern(q));
  }

  // One round trip: the total and the page together.
  const [countRes, rows] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(submissionCountSql(where)).bind(...binds),
    ctx.env.DB.prepare(submissionListSql(where, sort)).bind(...binds, limit, offset),
  ]);
  const total = (countRes.results?.[0] as { n?: number } | undefined)?.n ?? 0;

  return json(200, { data: rows.results ?? [], total, limit, offset }, {
    'cache-control': 'public, max-age=60, stale-while-revalidate=300',
  });
};
