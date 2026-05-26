import type { Env } from '../../_middleware';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const rows = await ctx.env.DB.prepare(
      'SELECT layer_id, format, count FROM download_counts',
    ).all<{ layer_id: string; format: string; count: number }>();

    const counts: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const r of rows.results ?? []) {
      if (!counts[r.layer_id]) counts[r.layer_id] = {};
      counts[r.layer_id][r.format] = r.count;
      total += r.count;
    }

    return new Response(JSON.stringify({ data: counts, total }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=30, stale-while-revalidate=120',
      },
    });
  } catch {
    return new Response(JSON.stringify({ data: {}, total: 0 }), {
      headers: { 'content-type': 'application/json' },
    });
  }
};
