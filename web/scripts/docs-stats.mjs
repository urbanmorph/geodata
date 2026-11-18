// Catalog figures the /docs developer page prints. Pure, so the numbers are
// unit-tested and never typed in by hand: they follow catalog.json on every build.
// The download total is passed in: the build's live counts (download-counts.mjs),
// the same figure the home page shows.

/** The site's one layer total: every curated layer (alternates count one by
 *  one) plus every accepted community submission. A submission baked into the
 *  catalog (provenance 'community') is that same submission, so it counts once. */
export function layerTotal(catalog, community = []) {
  return (catalog.layers || []).filter((l) => l.provenance !== 'community').length + community.length;
}

/** Layer count, layers per licence (most used first, then by name), downloads. */
export function docsStats(catalog, downloads = 0, community = []) {
  const counts = new Map();
  for (const l of catalog.layers || []) {
    const key = l.licence || 'not stated';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const licences = [...counts].sort((a, b) =>
    (a[0] === 'not stated') - (b[0] === 'not stated') || b[1] - a[1] || a[0].localeCompare(b[0]));
  return { layers: layerTotal(catalog, community), licences, downloads };
}
