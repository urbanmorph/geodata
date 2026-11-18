// Layer ids folded into another layer: old id -> new id. The /view page and the
// API detail answer 301 to the new id (Pages Functions own those routes, so
// _redirects can't). Add an entry whenever a layer id is retired.
export const RETIRED_LAYERS: Readonly<Record<string, string>> = {
  // The merged CRIS + GatiShakti + Wikidata set took over ir_stations (2026-11-18).
  ir_stations_merged: 'ir_stations',
};

/** A 301 to the same URL with the retired id swapped for its successor, or null for a live id. */
export function retiredRedirect(url: URL, id: string): Response | null {
  const to = Object.hasOwn(RETIRED_LAYERS, id) ? RETIRED_LAYERS[id] : undefined;
  if (!to) return null;
  const next = new URL(url);
  next.pathname = url.pathname.replace(new RegExp(`/${id}(?=/|$)`), `/${to}`);
  return Response.redirect(next.toString(), 301);
}
