// GET /api/r2/<key…> — stream the R2 object as a same-origin response.
//
// Used for "view on map" links from /c/[id] and any other place we want to
// hand a community-submitted file to /verify. The /api/dl/* endpoint 302s
// to the public R2 URL — fine for curated files that genuinely live there,
// useless for locally-submitted community files in dev. This endpoint reads
// from env.R2 directly so the same code path works in miniflare and in
// production.

import type { Env } from '../_middleware';
import { getSubmissionForView } from '../../lib/submissions';
import { apiError } from '../../lib/http';
import { CACHE_CONTROL } from '../../lib/edge-cache';

const notFound = () => apiError(404, 'not found');

type Params = { path: string[] };

// Tight allowlist: this endpoint exists to serve community-submitted files
// (see render-view.ts → /api/r2/community/<id>/<filename>). Curated layers
// are served via the public R2 URL (pub-…r2.dev/…) directly, never through
// here. Reject any other prefix so a future stray object can't be exfiltrated
// via the bharatlas-branded same-origin path.
const ALLOWED_PREFIX = /^community\//;

// Pages delivers catch-all segments still percent-encoded: a space in a
// community filename (e.g. "TEMPLE IN AHMEDABAD JDSM.kml") arrives as "%20".
// Decode each segment so the reconstructed key matches the literal R2 object
// key — otherwise env.R2.get() misses and every spaced filename 404s. Returns
// null on a malformed escape (a lone '%' throws in decodeURIComponent).
export function reconstructKey(segs: string[]): string | null {
  try {
    return segs.map((s) => decodeURIComponent(s)).join('/');
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const segs = (ctx.params.path as string[]) || [];
  const key = reconstructKey(segs);
  if (key === null) return apiError(400, 'bad key');
  if (!key) return apiError(400, 'missing key');
  if (!ALLOWED_PREFIX.test(key)) return notFound();
  // Only accepted submissions: pending, rejected and withdrawn uploads stay
  // private even to someone holding the link (review 2026-11-18).
  const subId = key.split('/')[1] ?? '';
  if (!(await getSubmissionForView(ctx.env.DB, subId))) return notFound();

  const obj = await ctx.env.R2.get(key);
  if (!obj) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', CACHE_CONTROL.page);
  // CORS (*, for reads) is added by api/_middleware.ts.

  return new Response(obj.body, { headers });
};
