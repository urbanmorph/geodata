import type { Env } from '../../_middleware';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10), 1), 100);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
  const sort = url.searchParams.get('sort') === 'useful' ? 'useful_count DESC' : 'created_at DESC';
  const category = url.searchParams.get('category');
  const q = url.searchParams.get('q');

  let where = "status = 'accepted'";
  const binds: unknown[] = [];

  if (category) {
    where += ' AND category = ?';
    binds.push(category);
  }
  if (q) {
    where += ' AND (name LIKE ? OR description LIKE ?)';
    binds.push(`%${q}%`, `%${q}%`);
  }

  const countRow = await ctx.env.DB.prepare(`SELECT COUNT(*) as n FROM submissions WHERE ${where}`)
    .bind(...binds).first<{ n: number }>();
  const total = countRow?.n ?? 0;

  const rows = await ctx.env.DB.prepare(
    `SELECT id, created_at, name, description, category, license, attribution,
            source_url, data_year, format, bytes, feature_count, geometry_types, useful_count
     FROM submissions WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();

  return new Response(JSON.stringify({
    data: rows.results ?? [],
    total,
    limit,
    offset,
  }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
};
