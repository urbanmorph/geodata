// GET /releases/… — see lib/releases.ts for what each path serves.
import { releaseRoute, sumsList, latestCode, loadReleaseIndex } from '../lib/releases';
import { json } from '../lib/http';
import { notFoundResponse } from '../lib/not-found';

type Params = { path: string[] };
type Env = { ASSETS: { fetch: (req: Request) => Promise<Response> } };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const route = releaseRoute(((ctx.params.path as string[]) || []).filter(Boolean));
  if (route.kind === 'page') {
    if (route.dataset && !latestCode((await loadReleaseIndex(ctx)) || {}, route.dataset)) {
      return notFoundResponse(ctx, { title: 'No such release', message: `bharatlas has no releases of "${route.dataset}".`,
        extra: '<p><a href="/releases">All releases</a></p>' });
    }
    return ctx.next();   // dist/releases.html or dist/releases/<dataset>.html
  }
  if (route.kind === 'latest') {
    const code = latestCode((await loadReleaseIndex(ctx)) || {}, route.dataset);
    if (!code) return notFound();
    // short-lived: the newest release changes when one is cut
    return new Response(null, { status: 302, headers: {
      location: `/releases/${code}${route.file ? `/${route.file}` : ''}`, 'cache-control': 'public, max-age=300' } });
  }
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

const notFound = () => json(404, { error: 'No such release or file', status: 404 });

// HEAD gets the same answer (the runtime drops the body), so link checkers see the redirect or the 404,
// not the site's single-page-app fallback.
export const onRequestHead = onRequestGet;
