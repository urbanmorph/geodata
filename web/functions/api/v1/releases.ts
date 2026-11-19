// GET /api/v1/releases — bharatlas's dated releases (crosswalks, the catalogue record), newest first: each code,
// its SHA-256 pin, files and manifest. The same document as /releases/index.json, in the API envelope.
import type { Env } from '../_middleware';
import { apiError, json } from '../../lib/http';
import { loadReleaseIndex } from '../../lib/releases';

const CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const index = await loadReleaseIndex(ctx);
  if (!index) return apiError(500, 'release index unavailable');
  return json(200, { data: index }, { 'cache-control': CACHE });
};
