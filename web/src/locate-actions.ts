import type { FilterSpecification } from 'maplibre-gl';
import { escapeHtml } from '../../shared/format.mjs';
import { INDIA_BBOX } from './india-bbox';
// Pure helpers for the Find-my-location result-sheet actions (Zoom / Highlight
// / Share). No DOM, no map — just data in, data out, so they're unit-testable.

// A MapLibre filter that matches exactly the located feature. The locate result
// and the rendered vector tiles come from the *same* pmtiles, so asserting every
// scalar property the result carries uniquely picks that one feature out of its
// neighbours (extra tile-only props don't break an `all` match). Nearest mode
// answers from the parquet, which can carry columns the tiles drop, so given the
// tiles' property names (tileKeys) only those are matched on. Returns null
// when there's nothing usable to match on (caller should skip highlighting
// rather than match-all).
export function buildFeatureFilter(props: Record<string, unknown>, tileKeys?: Set<string> | null): FilterSpecification | null {
  const conds = Object.entries(props)
    .filter(([k]) => !tileKeys || tileKeys.has(k))
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => ['==', ['get', k], v]);
  return conds.length ? (['all', ...conds] as FilterSpecification) : null;
}

/** A city ward layer (wards_<city>...): its level is its own id. Here, with the
 *  home page's other locate helpers, so find-my-ward loads no config tables. */
export const isWardLayer = (idOrLevel: string | null | undefined): boolean => !!idOrLevel && /^wards_/.test(idOrLevel);

// Shareable link that reopens this located view: /view/<id>?at=<lat>,<lng>.
// 5 decimals ≈ 1 m — enough to land back in the same feature without leaking a
// more precise coordinate than necessary.
export function shareUrl(origin: string, layerId: string, lat: number, lng: number): string {
  return `${origin}/view/${encodeURIComponent(layerId)}?at=${lat.toFixed(5)},${lng.toFixed(5)}`;
}

// The sky over a located ward, on mugilu (mugilu.live/c/<lat>,<lng>): ward layers only. The point is rounded to
// 2 decimals (about 1 km), enough for the air and weather there and no more precise than that.
export function skyUrl(layerId: string, lat: number, lng: number): string | null {
  return isWardLayer(layerId)
    ? `https://mugilu.live/c/${lat.toFixed(2)},${lng.toFixed(2)}?utm_source=bharatlas&utm_medium=ward_locate`
    : null;
}

/** The locate card's link out to mugilu: what is there, for this ward, now. */
export function skyLinkHtml(url: string, wardName: string): string {
  return `<p class="ls-sub ls-sky"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">` +
    `Air quality and weather in ${escapeHtml(wardName)} right now <span class="ls-sky__via">on mugilu ↗</span></a></p>`;
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
  const [w, south, e, north] = INDIA_BBOX;
  if (lat < south || lat > north || lng < w || lng > e) return null;
  return { lat, lng };
}
