// GET /api/v1/releases — bharatlas's dated releases (crosswalks, the catalogue record), newest first: each code,
// its SHA-256 pin, files and manifest. The same document as /releases/index.json, in the API envelope.
import type { Env } from '../_middleware';

const CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL('/releases/index.json', ctx.request.url);
  let index: unknown;
  try {
    const r = await ctx.env.ASSETS.fetch(url.toString());
    if (!r.ok) throw new Error(String(r.status));
    index = await r.json();   // the single-page-app fallback (HTML) fails here too
  } catch {
    return new Response(JSON.stringify({ error: 'release index unavailable', status: 500 }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ data: index }), {
    headers: { 'content-type': 'application/json', 'cache-control': CACHE },
  });
};
