// Edge-rendered view page for /c/[id]. Pulls submission row + ratings count
// in parallel, renders pure HTML with full SEO head and JSON-LD Dataset.
// Cached at the edge for 5 minutes; client-side JS handles the rating POST.

import { getSubmissionForView } from '../lib/submissions';
import { countVotes } from '../lib/ratings';
import { renderViewPage } from '../lib/render-view';
import type { Env as MiddlewareEnv } from '../api/_middleware';

type Env = MiddlewareEnv;
type Params = { id: string };

const NOT_FOUND_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Not found · geodata</title><meta name="robots" content="noindex"></head><body style="font:15px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#444"><h1 style="font-size:22px">404 — submission not found</h1><p>This submission ID doesn't exist, has been retracted, or hasn't been accepted yet.</p><p><a href="/" style="color:#0a58ca">← back to the catalog</a></p></body></html>`;

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;

  if (!/^[A-Za-z0-9_-]{8,16}$/.test(id)) {
    return new Response(NOT_FOUND_HTML, {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const [submission, tally] = await Promise.all([
    getSubmissionForView(ctx.env.DB, id),
    countVotes(ctx.env.DB, id),
  ]);
  // Display count = upvotes only ("N useful"). Legacy downvote totals in
  // pre-existing rows are intentionally ignored — see task #61.
  const ratingsCount = tally.up;

  if (!submission) {
    return new Response(NOT_FOUND_HTML, {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=60',
      },
    });
  }

  const url = new URL(ctx.request.url);
  const html = renderViewPage({
    submission,
    origin: url.origin,
    ratingsCount,
    alreadyRated: false,
    embed: url.searchParams.has('embed'),
  });

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400',
    },
  });
};

export const onRequest: PagesFunction<Env, keyof Params> = async () =>
  new Response('method not allowed', { status: 405 });
