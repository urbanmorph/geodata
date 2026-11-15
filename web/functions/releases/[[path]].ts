// GET /releases/… — see lib/releases.ts for what each path serves.
import { releaseRoute } from '../lib/releases';

type Params = { path: string[] };

export const onRequestGet: PagesFunction<unknown, keyof Params> = async (ctx) => {
  const route = releaseRoute(((ctx.params.path as string[]) || []).filter(Boolean));
  if (route.kind === 'static') {
    const asset = await ctx.next();
    // Pages answers a missing file with its single-page-app fallback (index.html, 200): that is a 404 here.
    if (!asset.ok || (asset.headers.get('content-type') || '').startsWith('text/html')) return notFound();
    const headers = new Headers(asset.headers);
    for (const [k, v] of Object.entries(route.headers)) headers.set(k, v);
    return new Response(asset.body, { status: asset.status, headers });
  }
  if (route.kind === 'redirect') {
    return new Response(null, { status: route.status, headers: { location: route.location, 'cache-control': 'public, max-age=3600' } });
  }
  return notFound();
};

const notFound = () =>
  new Response(JSON.stringify({ error: 'No such release or file', status: 404 }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
