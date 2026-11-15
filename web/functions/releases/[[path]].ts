// GET /releases/… — see lib/releases.ts for what each path serves.
import { releaseRoute, sumsList } from '../lib/releases';

type Params = { path: string[] };
type Env = { ASSETS: { fetch: (req: Request) => Promise<Response> } };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const route = releaseRoute(((ctx.params.path as string[]) || []).filter(Boolean));
  if (route.kind === 'static') {
    const asset = await ctx.next();
    // Pages answers a missing file with its single-page-app fallback (index.html, 200): that is a 404 here.
    if (!asset.ok || (asset.headers.get('content-type') || '').startsWith('text/html')) return notFound();
    const headers = new Headers(asset.headers);
    for (const [k, v] of Object.entries(route.headers)) headers.set(k, v);
    return new Response(asset.body, { status: asset.status, headers });
  }
  if (route.kind === 'data') {
    // Only files the release lists go to R2, so a wrong code or name is a 404 here, not a bounce to R2's 404.
    const sums = await ctx.env.ASSETS.fetch(new Request(new URL(route.sums, ctx.request.url)));
    const isText = !(sums.headers.get('content-type') || '').startsWith('text/html');
    if (!sums.ok || !isText || !sumsList(await sums.text(), route.file)) return notFound();
    return new Response(null, { status: 302, headers: { location: route.location, 'cache-control': 'public, max-age=3600' } });
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

// HEAD gets the same answer (the runtime drops the body), so link checkers see the redirect or the 404,
// not the site's single-page-app fallback.
export const onRequestHead = onRequestGet;
