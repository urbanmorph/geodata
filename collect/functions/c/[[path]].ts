// Serve the SPA shell (c.html) for every /c/<id>[/admin|/view] route. The client
// reads the id from the path and the token from the fragment.
//
// The asset response carries the _headers rules for /c.html (the `/*` security
// block), not those for /c/*, so the map pages' noindex is set here.
import type { Env } from '../types';

export const onRequest: PagesFunction<Env & { ASSETS: Fetcher }> = async (ctx) => {
  const asset = await ctx.env.ASSETS.fetch(new URL('/c.html', ctx.request.url));
  const res = new Response(asset.body, asset);
  res.headers.set('X-Robots-Tag', 'noindex');
  return res;
};
