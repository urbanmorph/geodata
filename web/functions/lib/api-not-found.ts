import { apiError } from './http';
import { isSpaFallback } from './catalog-loader';

/** The JSON 404 for a path that is not an endpoint (or not one yet). */
export const notFoundJson = (pathname: string): Response => apiError(404, `Not found: ${pathname}`);

/**
 * An /api path no function handles falls through to the site's HTML page with
 * a 200. No /api function returns HTML, so an HTML response there means "no
 * such endpoint": answer with a JSON 404 that API clients and agents can read.
 */
export function notFoundForUnmatched(resp: Response, pathname: string): Response {
  return isSpaFallback(resp) ? notFoundJson(pathname) : resp;
}
