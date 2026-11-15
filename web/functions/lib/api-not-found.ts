/**
 * An /api path no function handles falls through to the site's HTML page with
 * a 200. No /api function returns HTML, so an HTML response there means "no
 * such endpoint": answer with a JSON 404 that API clients and agents can read.
 */
export function notFoundForUnmatched(resp: Response, pathname: string): Response {
  if (!(resp.headers.get('content-type') ?? '').startsWith('text/html')) return resp;
  return new Response(JSON.stringify({ error: `Not found: ${pathname}`, status: 404 }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}
