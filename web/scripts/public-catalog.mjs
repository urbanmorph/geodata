// The /catalog.json the site serves (and the API and MCP read): the repo's
// catalog.json without each layer's `source_check` and `refresh`, the
// bookkeeping that scripts/check_updates.py and scripts/populate_refresh.py
// keep on upstream versions and rebuild schedules. No page or endpoint uses
// them, so they stay out of every browser's download.
//
// Each layer gains `versions`: its dated releases (scripts/release.py, the
// dataset code is the layer id), newest first, so an agent can cite one.

/** A dataset's releases from web/public/releases/index.json, newest first. */
export function layerVersions(index, dataset) {
  return (index?.releases || [])
    .filter((r) => r.dataset === dataset)
    .sort((a, b) => b.code.localeCompare(a.code))
    .map((r) => ({ code: r.code, released: r.released, sha256: r.sha256, w3id: r.w3id_proposed, url: r.url }));
}

export function publicCatalogJson(catalog, releaseIndex = null) {
  const layers = catalog.layers.map(({ source_check, refresh, ...layer }) =>
    ({ ...layer, versions: layerVersions(releaseIndex, layer.id) }));
  return JSON.stringify({ ...catalog, layers }, null, 2) + '\n';
}
