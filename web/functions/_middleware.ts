// Root middleware: turn Cloudflare Pages' single-page-app fallback (index.html
// served at HTTP 200 for any unmatched path) into a real 404 for unknown page
// URLs, so search engines don't index bogus or stale paths as duplicates of
// the home page. Known routes — prerendered pages, static assets, /view, /c,
// /api, /embed, and the _redirects stubs — pass straight through untouched.
// See lib/routes.ts for the allowlist (kept in sync with the build by a test).
import { isKnownRoute } from './lib/routes';
import { SECURITY_HEADERS_HTML } from './lib/security-headers';

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · bharatlas</title><meta name="robots" content="noindex"><style>:root{color-scheme:light dark}body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#0a0a0a;background:#fff}h1{font-size:22px;margin:0 0 8px}a{color:#4f46e5}@media(prefers-color-scheme:dark){body{color:#ededed;background:#0a0a0a}a{color:#818cf8}}</style></head><body><h1>404 — page not found</h1><p>This page doesn't exist on bharatlas.</p><p><a href="/">← back to the catalog</a></p></body></html>`;

export const onRequest: PagesFunction = async (ctx) => {
  if (isKnownRoute(new URL(ctx.request.url).pathname)) return ctx.next();
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS_HTML },
  });
};
