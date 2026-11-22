// The sitemap's page list, in one place. The build writes public/sitemap.xml
// from it (web/scripts/prerender.mjs); the edge sitemap (web/functions/sitemap.xml.ts),
// which overrides that file, adds the layer and community pages to the same list.
import { escXml } from './kml.mjs';
import { SITE_ORIGIN } from './brand.mjs';

export { SITE_ORIGIN };

export const STATIC_PAGES = [
  { loc: SITE_ORIGIN + '/', changefreq: 'weekly', priority: '1.0' },
  { loc: SITE_ORIGIN + '/layers', changefreq: 'weekly', priority: '0.9' },
  { loc: SITE_ORIGIN + '/about', changefreq: 'monthly', priority: '0.8' },
  { loc: SITE_ORIGIN + '/preview', changefreq: 'monthly', priority: '0.8' },
  { loc: SITE_ORIGIN + '/docs', changefreq: 'monthly', priority: '0.7' },
  { loc: SITE_ORIGIN + '/mcp', changefreq: 'monthly', priority: '0.7' },
  { loc: SITE_ORIGIN + '/releases', changefreq: 'monthly', priority: '0.5' },
  { loc: SITE_ORIGIN + '/design', changefreq: 'monthly', priority: '0.4' },
  { loc: SITE_ORIGIN + '/privacy', changefreq: 'yearly', priority: '0.3' },
  { loc: SITE_ORIGIN + '/terms', changefreq: 'yearly', priority: '0.3' },
];

/** One page per dataset with a release, from the release index (none when it is missing). */
export const releasePages = (index) =>
  Object.keys(index?.latest || {}).map((d) => ({ loc: `${SITE_ORIGIN}/releases/${d}`, changefreq: 'monthly', priority: '0.4' }));

/** A <lastmod> line (leading newline + indent) when `date` is a date we can trust, else ''.
 *  Only some layers carry fetched_at; a made-up date costs more crawl trust than none. */
export function lastmodLine(date) {
  const d = (date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `\n    <lastmod>${d}</lastmod>` : '';
}

/** The sitemap document for these entries ({ loc, lastmod?, changefreq, priority }). */
export const urlset = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((u) => `  <url>
    <loc>${escXml(u.loc)}</loc>${lastmodLine(u.lastmod)}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
