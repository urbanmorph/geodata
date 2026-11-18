// The /catalog.json the site serves (and the API and MCP read): the repo's
// catalog.json without each layer's `source_check`, the bookkeeping that
// scripts/check_updates.py keeps on upstream versions. No page or endpoint
// uses it, so it stays out of every browser's download.
export function publicCatalogJson(catalog) {
  const layers = catalog.layers.map(({ source_check, ...layer }) => layer);
  return JSON.stringify({ ...catalog, layers }, null, 2) + '\n';
}
