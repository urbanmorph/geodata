// Edge-rendered sitemap. The build's pages (shared/sitemap.mjs), each dataset's
// /releases/<dataset> page, every layer's /view/<id> and every accepted community
// submission's /c/<id> from D1. Cached 1h with SWR so
// the response is fast and stays fresh between submits.
//
// Overrides the static web/public/sitemap.xml that the prerender emits —
// CF Pages Functions take precedence over static files at the same path.

import type { Env } from './api/_middleware';
import { SECURITY_HEADERS_NON_HTML } from './lib/security-headers';
import { loadCatalog } from './lib/catalog-loader';
import type { CatalogLayer } from './lib/catalog-api';
import { cachedLive } from './lib/edge-cache';
import { loadReleaseIndex, type ReleaseIndex } from './lib/releases';
import { STATIC_PAGES, SITE_ORIGIN, releasePages, urlset } from '../../shared/sitemap.mjs';

type Community = { id: string; created_at: string; updated_at: string | null };
type Parts = { releases: ReleaseIndex | null; curated: Array<Pick<CatalogLayer, 'id' | 'fetched_at'>>; community: Community[] };

/** The served sitemap: the build's pages (shared/sitemap.mjs), each dataset's
 *  release page, every layer's /view page and every accepted community page. */
export const sitemapXml = ({ releases, curated, community }: Parts): string => urlset([
  ...STATIC_PAGES,
  ...releasePages(releases),
  ...curated.map((l) => ({ loc: `${SITE_ORIGIN}/view/${l.id}`, lastmod: l.fetched_at, changefreq: 'weekly', priority: '0.7' })),
  ...community.map((c) => ({ loc: `${SITE_ORIGIN}/c/${c.id}`, lastmod: c.updated_at || c.created_at, changefreq: 'weekly', priority: '0.5' })),
]);

// Kept an hour in the colo: one D1 read per colo per hour, not one per crawl.
export const onRequestGet: PagesFunction<Env> = (ctx) => cachedLive(ctx, () => render(ctx), 3600);

async function render(ctx: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  let community: Community[] = [];
  try {
    const r = await ctx.env.DB.prepare(
      `SELECT id, created_at, updated_at FROM submissions
       WHERE status = 'accepted' ORDER BY created_at DESC LIMIT 5000`,
    ).all();
    community = (r.results || []) as typeof community;
  } catch {
    // empty community is fine — static surfaces still ship
  }

  // Curated layers come from catalog.json (the deployment's own copy). v4.7 introduced
  // /view/<id> as the canonical share URL with layer-specific OG cards.
  let curated: Parts['curated'] = [];
  try {
    const cat = await loadCatalog(ctx);
    curated = cat.layers || [];
  } catch {
    // curated /view URLs are nice-to-have for sitemap; fall through quietly
  }

  const xml = sitemapXml({ releases: await loadReleaseIndex(ctx), curated, community });

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      ...SECURITY_HEADERS_NON_HTML,
    },
  });
}
