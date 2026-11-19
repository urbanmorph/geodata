// GET /og/c/<id>.png — community-submission OG card.
// Reads the D1 submission row, renders via the shared template. The PNG is
// kept in the edge cache, keyed by the deploy version and the row's
// updated_at, so an edited submission gets a fresh card.

import type { Env } from '../../api/_middleware';
import { communityMetadata } from '../../lib/og-metadata';
import { renderOgPng } from '../../lib/og-render';
import { ogError, PNG_HEADERS } from '../../lib/og-response';
import { renderOgSvg } from '../../lib/og-template';
import { getSubmissionForView } from '../../lib/submissions';
import { SUBMISSION_ID } from '../../lib/submissions-sql';
import { loadCatalogVersioned } from '../../lib/catalog-loader';
import { cached, cacheKey, EDGE_TTL } from '../../lib/edge-cache';

type Params = { id: string };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = (ctx.params.id as string) || '';
  if (!SUBMISSION_ID.test(id)) return ogError(404, 'invalid submission id');

  const submission = await getSubmissionForView(ctx.env.DB, id);
  if (!submission) return ogError(404, 'submission not found');

  const render = async () => new Response(await renderOgPng(renderOgSvg(communityMetadata(submission)), ctx), { headers: PNG_HEADERS });
  // Without the deploy version (catalog unreachable) the card is still drawn, just not kept.
  const loaded = await loadCatalogVersioned(ctx).catch(() => null);
  if (!loaded) return render();
  const stamp = encodeURIComponent(submission.updated_at ?? submission.created_at);
  const key = `${cacheKey(loaded.version, new URL(ctx.request.url), { query: false })}?u=${stamp}`;
  return cached(ctx, key, EDGE_TTL.page, render);
};
