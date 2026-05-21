// Edge-rendered sitemap. Static surfaces (/, /about, /preview) + every
// accepted community submission's /c/<id> from D1. Cached 1h with SWR so
// the response is fast and stays fresh between submits.
//
// Overrides the static web/public/sitemap.xml that the prerender emits —
// CF Pages Functions take precedence over static files at the same path.

import type { Env } from './api/_middleware';

const ORIGIN = 'https://bharatlas.com';

const STATIC: Array<{ loc: string; changefreq: string; priority: string }> = [
  { loc: ORIGIN + '/', changefreq: 'weekly', priority: '1.0' },
  { loc: ORIGIN + '/about', changefreq: 'monthly', priority: '0.8' },
  { loc: ORIGIN + '/preview', changefreq: 'monthly', priority: '0.8' },
];

const escXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  let community: Array<{ id: string; created_at: string; updated_at: string | null }> = [];
  try {
    const r = await ctx.env.DB.prepare(
      `SELECT id, created_at, updated_at FROM submissions
       WHERE status = 'accepted' ORDER BY created_at DESC LIMIT 5000`,
    ).all();
    community = (r.results || []) as typeof community;
  } catch {
    // empty community is fine — static surfaces still ship
  }

  const urls = [
    ...STATIC.map(
      (u) => `  <url>
    <loc>${escXml(u.loc)}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`,
    ),
    ...community.map(
      (s) => `  <url>
    <loc>${escXml(ORIGIN + '/c/' + s.id)}</loc>
    <lastmod>${escXml((s.updated_at || s.created_at).slice(0, 10))}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>`,
    ),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
};
