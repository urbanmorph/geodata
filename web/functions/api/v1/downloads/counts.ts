import type { Env } from '../../_middleware';
import { shapeDownloadCounts } from '../../../lib/counters';
import { json } from '../../../lib/http';

// Same totals as /api/dl/counts (per-state and backfill rows are added up), in the v1 envelope.
export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const rows = await ctx.env.DB.prepare(
      'SELECT layer_id, format, count FROM download_counts',
    ).all<{ layer_id: string; format: string; count: number }>();
    const { _total, ...data } = shapeDownloadCounts(rows.results ?? []);
    return json(200, { data, total: _total }, { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' });
  } catch {
    return json(200, { data: {}, total: 0 });
  }
};
