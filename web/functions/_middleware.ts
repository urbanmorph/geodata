// Root middleware: turn Cloudflare Pages' single-page-app fallback (index.html
// served at HTTP 200 for any unmatched path) into a real 404 for unknown page
// URLs, so search engines don't index bogus or stale paths as duplicates of
// the home page. Known routes — prerendered pages, static assets, /view, /c,
// /api, /embed, and the _redirects stubs — pass straight through untouched.
// See lib/routes.ts for the allowlist (kept in sync with the build by a test).
// (With dist/404.html in the build, Pages itself answers a missing file with a
// 404; this still catches extensionless paths before Pages tries them.)
import { isKnownRoute } from './lib/routes';
import { notFoundResponse } from './lib/not-found';
import type { AssetCtx } from './lib/catalog-loader';

const PAGE_NOT_FOUND = {
  title: 'Page not found',
  message: "There's no page at this address. It may have moved, or the link has a typo.",
};

export const onRequest: PagesFunction = async (ctx) => {
  if (isKnownRoute(new URL(ctx.request.url).pathname)) return ctx.next();
  return notFoundResponse(ctx as unknown as AssetCtx, PAGE_NOT_FOUND);
};
