// Edge-rendered view page for /c/[id]. Pulls submission row + ratings count
// in parallel, renders pure HTML with full SEO head and JSON-LD Dataset.
// Cached at the edge for 5 minutes; client-side JS handles the rating POST.

import { getSubmissionForView } from '../lib/submissions';
import { countVotes } from '../lib/ratings';
import { renderViewPage } from '../lib/render-view';
import { SECURITY_HEADERS_HTML } from '../lib/security-headers';
import type { Env as MiddlewareEnv } from '../api/_middleware';
import { notFoundResponse } from '../lib/not-found';

type Env = MiddlewareEnv;
type Params = { id: string };

const NOT_FOUND = {
  title: 'Submission not found',
  message: "This submission doesn't exist, was withdrawn, or hasn't been accepted yet.",
};

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;

  if (!/^[A-Za-z0-9_-]{8,16}$/.test(id)) return notFoundResponse(ctx, NOT_FOUND);

  const [submission, tally] = await Promise.all([
    getSubmissionForView(ctx.env.DB, id),
    countVotes(ctx.env.DB, id),
  ]);
  // Display count = upvotes only ("N useful"). Legacy downvote totals in
  // pre-existing rows are intentionally ignored — see task #61.
  const ratingsCount = tally.up;

  if (!submission) {
    return notFoundResponse(ctx, NOT_FOUND, { 'cache-control': 'public, max-age=60' });
  }

  const url = new URL(ctx.request.url);
  const html = renderViewPage({
    submission,
    ratingsCount,
    embed: url.searchParams.has('embed'),
  });

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400',
      ...SECURITY_HEADERS_HTML,
    },
  });
};

// HEAD (link checkers, crawlers) is answered like GET; other methods are not allowed.
export const onRequestHead = onRequestGet;

export const onRequest: PagesFunction<Env, keyof Params> = async () =>
  new Response('method not allowed', { status: 405 });
