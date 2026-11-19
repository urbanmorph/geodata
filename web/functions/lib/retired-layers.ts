// Layer ids folded into another layer: old id -> new id. The /view page and
// every API call that names a layer answer 301 to the new id (Pages Functions
// own those routes, so _redirects can't). Add an entry whenever a layer id is retired.
export const RETIRED_LAYERS: Readonly<Record<string, string>> = {
  // The merged CRIS + GatiShakti + Wikidata set took over ir_stations (2026-11-18).
  ir_stations_merged: 'ir_stations',
};

/** The successor of a retired id, or undefined for a live (or unknown) one. */
export const successorOf = (id: string): string | undefined =>
  (Object.hasOwn(RETIRED_LAYERS, id) ? RETIRED_LAYERS[id] : undefined);

/** A 301 to the same URL with the retired id swapped for its successor (in the
 *  path, e.g. /view/<id> or /og/view/<id>.png, or in query parameter `param`),
 *  or null for a live id. */
export function retiredRedirect(url: URL, id: string, param?: string): Response | null {
  const to = successorOf(id);
  if (!to) return null;
  const next = new URL(url);
  if (param) next.searchParams.set(param, to);
  else next.pathname = url.pathname.replace(new RegExp(`/${id}(?=[/.]|$)`), `/${to}`);
  return Response.redirect(next.toString(), 301);
}
