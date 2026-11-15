// Root middleware: turn Cloudflare Pages' single-page-app fallback (index.html
// served at HTTP 200 for any unmatched path) into a real 404 for unknown page
// URLs, so search engines don't index bogus or stale paths as duplicates of
// the home page. Known routes — prerendered pages, static assets, /view, /c,
// /api, /embed, and the _redirects stubs — pass straight through untouched.
// See lib/routes.ts for the allowlist (kept in sync with the build by a test).
import { isKnownRoute } from './lib/routes';
import { SECURITY_HEADERS_HTML } from './lib/security-headers';
import { notFoundHtml } from './lib/not-found';

const NOT_FOUND_HTML = notFoundHtml('page not found', "This page doesn't exist on bharatlas.");

export const onRequest: PagesFunction = async (ctx) => {
  if (isKnownRoute(new URL(ctx.request.url).pathname)) return ctx.next();
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS_HTML },
  });
};
