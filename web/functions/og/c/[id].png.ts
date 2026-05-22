// GET /og/c/<id>.png — community-submission OG card.
// Reads the D1 submission row, renders via the shared template.

import type { Env } from '../../api/_middleware';
import { communityMetadata } from '../../lib/og-metadata';
import { renderOgPng } from '../../lib/og-render';
import { ogError, PNG_HEADERS } from '../../lib/og-response';
import { renderOgSvg } from '../../lib/og-template';
import { getSubmissionForView } from '../../lib/submissions';

type Params = { id: string };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = (ctx.params.id as string) || '';
  if (!/^[A-Za-z0-9_-]{8,16}$/.test(id)) return ogError(404, 'invalid submission id');

  const submission = await getSubmissionForView(ctx.env.DB, id);
  if (!submission) return ogError(404, 'submission not found');

  const origin = new URL(ctx.request.url).origin;
  const png = await renderOgPng(renderOgSvg(communityMetadata(submission)), origin);
  return new Response(png, { headers: PNG_HEADERS });
};
