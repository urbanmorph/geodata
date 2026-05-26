// GET /api/dl/counts — returns all download counts from D1 in one call.
// The client fetches this on page load and patches the badge spans so
// counts are always live (no catalog.json drift).
//
// Response shape: { "lgd_states": { "parquet": 86, "geojson": 12 }, ... }
// Plus a _total key with the grand total.

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

    return new Response(JSON.stringify({ ...counts, _total: total }), {
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=30, stale-while-revalidate=120',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ _total: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });
  }
};
