// The home page's India map (build time). One outline, defined once and reused
// as land, clip and edge; the city-ward markers come from the ward bounding
// boxes, so a new ward layer shows up on the next build. The other themes are
// fetched on demand from /map-themes.json (scripts/build_map_themes.py) and drawn
// by src/india-map.ts. Pure, so tests/india-map.test.ts can check it.
import { INDIA_PATH } from '../functions/lib/og-india-path.ts';
import { escapeHtml as esc, fmtInt } from '../../shared/format.mjs';

// The share-card frame INDIA_PATH was drawn in: 67.5..98.5°E, 5.5..38°N fitted
// into a 460 x 480 box at (90, 75). build_map_themes.py uses the same numbers.
const SCALE = 480 / 32.5;
const X0 = 90 + (460 - 31 * SCALE) / 2;
const Y0 = 75;
export const MAP_VIEWBOX = '80 65 470 490';

/**
 * INDIA_PATH at map resolution: whole pixels, points under min px apart dropped.
 * Every shape is kept, however small (islands included): a shape too small to
 * thin keeps all its points. The share cards keep the full path; the map is ~520px.
 */
export function lightenPath(d, min = 1.5) {
  return d
    .split(/(?=[MZ])/)
    .map((sub) => {
      if (sub.trim() === 'Z') return 'Z';
      const pts = [...sub.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Math.round(+m[1]), Math.round(+m[2])]);
      const kept = pts.filter((p, i) => i === 0 || i === pts.length - 1 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) >= min);
      return 'M' + (kept.length > 2 ? kept : pts).map((p) => p.join(' ')).join(' ');
    })
    .join('');
}
const OUTLINE = lightenPath(INDIA_PATH);

/** [x, y] of a longitude/latitude in the map frame. */
export function project(lon, lat) {
  return [X0 + (lon - 67.5) * SCALE, Y0 + (38 - lat) * SCALE];
}

/** One marker per city: ward layers with the same centre (vintages) collapse. */
export function wardCities(bboxes) {
  const cities = [];
  for (const [w, s, e, n] of Object.values(bboxes)) {
    const [x, y] = project((w + e) / 2, (s + n) / 2);
    const r = 4 + (e - w) * 9;
    const same = cities.find((c) => Math.hypot(c.x - x, c.y - y) < 2);
    if (same) same.r = Math.max(same.r, r);
    else cities.push({ x, y, r });
  }
  return cities;
}

/** Pointy-top hexagons, one closed subpath each, drawn from the top vertex. */
export function hexPath(cells) {
  return cells
    .map(({ x, y, r }) => {
      const a = ((r * Math.sqrt(3)) / 2).toFixed(1);
      const b = (r / 2).toFixed(1);
      return `M${x.toFixed(1)} ${(y - r).toFixed(1)}l${a} ${b}v${2 * b}l-${a} ${b}l-${a} -${b}v-${2 * b}z`;
    })
    .join('');
}

/** The five themes, in chip order, with captions built from the catalogue's counts. */
export function mapThemes(catalog, cityCount) {
  const rows = (id) => fmtInt(catalog.layers.find((l) => l.id === id)?.rows);
  return [
    { key: 'wards', label: 'City wards', caption: `Ward maps for ${cityCount} cities. Village and town boundaries everywhere.` },
    { key: 'rail', label: 'Rail', caption: `Indian Railways: ${rows('ir_tracks')} track sections, ${rows('ir_stations')} stations` },
    { key: 'rivers', label: 'Water', caption: `The 40 longest of ${rows('wris_rivers')} rivers mapped by India-WRIS` },
    { key: 'schools', label: 'Schools', caption: `${rows('udise_schools')} schools (UDISE+); darker hexagons have more` },
    { key: 'forests', label: 'Forests', caption: `${rows('soi_forests')} forest areas (Survey of India); darker hexagons have more` },
  ];
}

/** The map figure: theme switch, the outline, and the inline ward theme.
 *  cityCount: the cities with ward maps (nearby cities can share one marker). */
export function indiaMapHtml({ wardBboxes, catalog, cityCount }) {
  const cities = wardCities(wardBboxes);
  const themes = mapThemes(catalog, cityCount ?? cities.length);
  const chips = themes
    .map(
      (t, i) =>
        `<button type="button" class="india-map__chip" data-map-theme="${t.key}" aria-pressed="${i === 0}" data-caption="${esc(t.caption)}">${esc(t.label)}</button>`,
    )
    .join('');
  return `<figure class="india-map" data-india-map>
  <div class="india-map__chips" role="group" aria-label="Show on the map">${chips}</div>
  <div class="india-map__frame">
    <svg viewBox="${MAP_VIEWBOX}" role="img" aria-labelledby="india-map-caption">
      <defs>
        <path id="india-shape" d="${OUTLINE}"/>
        <clipPath id="india-clip"><use href="#india-shape"/></clipPath>
        <pattern id="india-dots" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r="1.25"/></pattern>
      </defs>
      <use class="india-map__land" href="#india-shape"/>
      <g class="india-map__layer" data-map-layer>
        <use class="india-map__villages" href="#india-shape"/>
        <path class="india-map__wards" d="${hexPath(cities)}"/>
      </g>
      <use class="india-map__edge" href="#india-shape"/>
    </svg>
    <figcaption class="india-map__caption" id="india-map-caption" data-map-caption aria-live="polite">${esc(themes[0].caption)}</figcaption>
  </div>
</figure>`;
}
