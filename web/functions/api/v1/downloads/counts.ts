import type { Env } from '../../_middleware';
import { downloadCounts } from '../../../lib/counters';
import { json } from '../../../lib/http';
import { cachedLive } from '../../../lib/edge-cache';

// Same totals as /api/dl/counts (per-state and backfill rows are added up), in the v1 envelope.
export const onRequestGet: PagesFunction<Env> = (ctx) =>
  cachedLive(ctx, async () => {
    const { _total, ...data } = await downloadCounts(ctx.env.DB);
    return json(200, { data, total: _total }, { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' });
  });
