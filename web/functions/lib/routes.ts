// Which top-level routes the site actually serves. Cloudflare Pages is
// configured to serve index.html (HTTP 200) for any unmatched path — a
// single-page-app fallback that turns every typo'd or stale URL into a soft
// 404 (a 200 that just duplicates the home page). The root _middleware uses
// this allowlist to convert those into real 404s so crawlers don't index
// bogus paths as duplicate home pages.
//
// Keep STATIC_PAGES in lockstep with the *.template.html files prerender
// emits — tests/routes.test.ts asserts the two never drift.

/** Prerendered single-page routes (one <name>.template.html each). '' = "/". */
export const STATIC_PAGES = new Set<string>([
  '', 'about', 'docs', 'mcp', 'preview', 'privacy', 'terms',
]);

/** First path segment owned by a Pages Function or a _redirects rule. These
 *  resolve themselves — the function returns its own status (including its own
 *  404 for a bad /view/<id>), the redirect returns 301 — so never police them. */
export const ROUTE_PREFIXES = new Set<string>([
  'view', 'c', 'api', 'embed',          // functions/view, functions/c, functions/api, _redirects /embed/*
  'verify', 'submit', 'contribute',     // _redirects → /preview (301)
]);

/** True when the site genuinely serves `pathname`, so the soft-404 guard must
 *  leave it alone. Any path whose final segment carries a file extension is
 *  treated as a static asset (Google never indexes those as pages). Only
 *  extensionless, unknown top-level paths — the SPA fallback's soft-404
 *  surface — return false. */
export function isKnownRoute(pathname: string): boolean {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 0) return true;                               // "/"
  if (segs[segs.length - 1].includes('.')) return true;            // file asset (*.js, *.png, robots.txt …)
  if (ROUTE_PREFIXES.has(segs[0])) return true;                    // a function / redirect owns this subtree
  if (segs.length === 1 && STATIC_PAGES.has(segs[0])) return true; // a prerendered page
  return false;
}
