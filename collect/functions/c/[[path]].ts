// Serve the SPA shell (c.html) for every /c/<id>[/admin|/view] route. The client
// reads the id from the path and the token from the fragment.
import type { Env } from '../types';

export const onRequest: PagesFunction<Env & { ASSETS: Fetcher }> = async (ctx) => {
  return ctx.env.ASSETS.fetch(new URL('/c.html', ctx.request.url));
};
