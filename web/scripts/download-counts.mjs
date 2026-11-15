// Download counts baked into the prerendered pages. The catalog's
// download_counts is a build-time snapshot that drifts (948 baked vs ~22k in
// D1, Nov 2026), and crawlers / link previews only see the baked HTML. So the
// build asks the live counter first and falls back to the snapshot.

const LIVE_URL = 'https://bharatlas.com/api/dl/counts';

/** Live counts `{layer: {fmt: n}, _total}` or null if unreachable / bad. */
export async function fetchLiveCounts(url = LIVE_URL, fetcher = fetch, timeoutMs = 8000) {
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const body = await r.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/** Per-layer `{fmt: n}` plus a total, from live counts or the catalog snapshot. */
export function bakedCounts(catalog, live) {
  if (live) {
    const { _total, ...layers } = live;
    return { layers, total: typeof _total === 'number' ? _total : sum(layers) };
  }
  // Snapshot shape: {layer: {state: {fmt: n}}}; state '' is the whole layer.
  const snapshot = Object.entries(catalog.download_counts || {});
  const layers = Object.fromEntries(snapshot.map(([id, byState]) => [id, byState[''] || {}]));
  const total = snapshot.reduce((s, [, byState]) => s + sum(byState), 0);
  return { layers, total };
}

export function countFor(counts, layerId, fmt) {
  const n = counts.layers[layerId]?.[fmt];
  return typeof n === 'number' && n > 0 ? n : 0;
}

export function totalDownloads(counts) {
  return counts.total;
}

/** Layer ids with the most downloads (all formats), highest first. */
export function mostDownloaded(counts, n, keep = () => true) {
  return Object.entries(counts.layers)
    .map(([id, byFmt]) => [id, sumObj(byFmt)])
    .filter(([id, total]) => total > 0 && keep(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

function sumObj(o) {
  return Object.values(o).reduce((s, n) => s + (typeof n === 'number' ? n : 0), 0);
}

function sum(layers) {
  return Object.values(layers).reduce((s, f) => s + sumObj(f), 0);
}
