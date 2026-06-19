// Pure helpers for the Find-my-location result-sheet actions (Zoom / Highlight
// / Share). No DOM, no map — just data in, data out, so they're unit-testable.

// A MapLibre filter that matches exactly the located feature. The locate result
// and the rendered vector tiles come from the *same* pmtiles, so asserting every
// scalar property the result carries uniquely picks that one feature out of its
// neighbours (extra tile-only props don't break an `all` match). Returns null
// when there's nothing usable to match on (caller should skip highlighting
// rather than match-all).
export function buildFeatureFilter(props: Record<string, unknown>): unknown[] | null {
  const conds = Object.entries(props)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => ['==', ['get', k], v]);
  return conds.length ? ['all', ...conds] : null;
}

// Shareable link that reopens this located view: /view/<id>?at=<lat>,<lng>.
// 5 decimals ≈ 1 m — enough to land back in the same feature without leaking a
// more precise coordinate than necessary.
export function shareUrl(origin: string, layerId: string, lat: number, lng: number): string {
  return `${origin}/view/${encodeURIComponent(layerId)}?at=${lat.toFixed(5)},${lng.toFixed(5)}`;
}

// Parse the ?at=lat,lng deep-link back into coords. Rejects anything outside the
// India bbox (same gate as the endpoint) so a malformed/hostile param can't
// drive the map somewhere nonsensical.
export function parseAtParam(raw: string | null): { lat: number; lng: number } | null {
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < 6 || lat > 38 || lng < 68 || lng > 98) return null;
  return { lat, lng };
}
