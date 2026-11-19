// GET /api/dl/counts — returns all download counts from D1 in one call.
// The client fetches this on page load and patches the badge spans so
// counts are always live (no catalog.json drift).
//
// Response shape: { "lgd_states": { "parquet": 86, "geojson": 12 }, ... }
// Plus a _total key with the grand total. A D1 failure is a 503 (the page
// keeps its baked counts), never zeros.

import type { Env } from '../_middleware';
import { downloadCounts } from '../../lib/counters';
import { json } from '../../lib/http';
import { cachedLive } from '../../lib/edge-cache';

export const onRequestGet: PagesFunction<Env> = (ctx) =>
  cachedLive(ctx, async () =>
    json(200, await downloadCounts(ctx.env.DB), { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' }));
