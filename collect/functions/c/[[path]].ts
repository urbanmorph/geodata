// Serve the SPA shell (c.html) for every map page (/c/<id>[/admin|/view] and
// /c/<id>/r/<record>; src/map-path.ts). The client reads the id from the path and
// the token from the fragment. Any other /c/ address is collect's 404 page.
//
// The asset response carries the _headers rules for /c.html (the `/*` security
// block), not those for /c/*, so the map pages' noindex is set here.
import type { Env } from '../types';
import { parseMapPath } from '../../src/map-path';

export const onRequest: PagesFunction<Env & { ASSETS: Fetcher }> = async (ctx) => {
  const isMap = parseMapPath(new URL(ctx.request.url).pathname) !== null;
  const asset = await ctx.env.ASSETS.fetch(new URL(isMap ? '/c.html' : '/404.html', ctx.request.url));
  const res = new Response(asset.body, isMap ? asset : { status: 404, headers: asset.headers });
  res.headers.set('X-Robots-Tag', 'noindex');
  return res;
};
