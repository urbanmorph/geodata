import type { Env } from '../../_middleware';

type Params = { id: string };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return json(400, { error: 'Invalid submission ID', status: 400 });
  }

  let row;
  try {
    row = await ctx.env.DB.prepare(
      `SELECT id, created_at, updated_at, status, name, description, category, license,
              attribution, source_url, data_year, format, bytes, feature_count,
              geometry_types, r2_key, useful_count
       FROM submissions WHERE id = ? AND status = 'accepted'`,
    ).bind(id).first();
  } catch {
    row = await ctx.env.DB.prepare(
      `SELECT id, created_at, status, name, description, category, license,
              attribution, source_url, format, bytes, feature_count, geometry_types, r2_key
       FROM submissions WHERE id = ? AND status = 'accepted'`,
    ).bind(id).first();
  }

  if (!row) return json(404, { error: 'Submission not found', status: 404 });

  return new Response(JSON.stringify({ data: row }), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30, stale-while-revalidate=300',
    },
  });
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
