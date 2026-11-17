// Graded colour for value layers: polygons carrying money or a measured
// quantity are coloured by one column, declared in the catalog entry as
// layer.choropleth = { column, label, unit, breaks }. The breaks are equal-count
// classes (quantiles, rounded to two significant figures) computed once from
// the layer's parquet by scripts/choropleth_breaks.py, so the map needs no data
// scan. Plain ESM, like the other shared modules.
import { escapeHtml as esc } from './format.mjs';

// One hue (India green), light to dark. Validated with the dataviz skill's
// validator (--ordinal) on the Minimal basemap's land (#f5f3ef): monotone
// lightness, adjacent steps apart, the lightest step clears 2:1 against the
// land so even the lowest class reads as data. Lightness alone carries the
// order, so it holds for colour-blind readers.
export const CHOROPLETH_RAMP = Object.freeze(['#77BA8D', '#4FA272', '#2B8657', '#17673F', '#0B4729']);

// Polygons without a value: no fill, hatched in navy, so "no data" never reads
// as the lowest class.
export const NO_DATA_HATCH = '#0B1B3F';

/** The no-data hatch as an RGBA tile for map.addImage: one diagonal per tile,
 *  bottom-left to top-right, so the tiles join into continuous lines. */
export function hatchPixels(size = 8) {
  const data = new Uint8Array(size * size * 4);
  const rgb = [1, 3, 5].map((i) => parseInt(NO_DATA_HATCH.slice(i, i + 2), 16));
  for (let y = 0; y < size; y++) {
    const i = (y * size + (size - 1 - y)) * 4;
    data.set([...rgb, 200], i);
  }
  return { width: size, height: size, data };
}

/** n colours from the ramp, spread evenly across it. */
export function rampFor(n) {
  const last = CHOROPLETH_RAMP.length - 1;
  if (n <= 1) return [CHOROPLETH_RAMP[Math.round(last / 2)]];
  return Array.from({ length: n }, (_, i) => CHOROPLETH_RAMP[Math.round((i * last) / (n - 1))]);
}

/** Legend number: Indian grouping, and lakh / crore in words for big values. */
export function fmtLegendNumber(n) {
  const fmt = (x) => x.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1e7) return `${fmt(n / 1e7)} crore`;
  if (Math.abs(n) >= 1e5) return `${fmt(n / 1e5)} lakh`;
  return fmt(n);
}

const hasValue = (column) => ['==', ['typeof', ['get', column]], 'number'];

/** MapLibre fill-color: step through the ramp; no number → transparent. */
export function fillColorExpr({ column, breaks }) {
  const colors = rampFor(breaks.length + 1);
  const step = ['step', ['get', column], colors[0]];
  breaks.forEach((b, i) => step.push(b, colors[i + 1]));
  return ['case', hasValue(column), step, 'rgba(0,0,0,0)'];
}

/** MapLibre filter for the features with no value (drawn hatched). */
export function noDataFilter({ column }) {
  return ['!', hasValue(column)];
}

/** A layer's own filter (e.g. points only) and-ed with the user's filter. */
export function combineFilters(base, user) {
  if (base && user) return ['all', base, user];
  return base ?? user ?? null;
}

const SHARE = { 2: 'about half', 3: 'about a third', 4: 'about a quarter', 5: 'about a fifth' };

/** The legend: column and unit, each class range in words, then no data. */
export function legendHtml({ label, unit, breaks }, unitNoun) {
  const colors = rampFor(breaks.length + 1);
  const n = breaks.map(fmtLegendNumber);
  const text = colors.map((_, i) =>
    i === 0 ? `under ${n[0]}` : i === breaks.length ? `${n[i - 1]} and over` : `${n[i - 1]} to ${n[i]}`);
  const row = (sw, t) => `<li><i class="map-legend__sw${sw.cls}"${sw.style}></i>${esc(t)}</li>`;
  const rows = colors.map((c, i) => row({ cls: '', style: ` style="background:${c}"` }, text[i])).join('') +
    row({ cls: ' map-legend__sw--none', style: '' }, 'No data');
  const share = SHARE[colors.length];
  const note = share && unitNoun ? `<p class="map-legend__note">Each shade holds ${share} of the ${esc(unitNoun)}.</p>` : '';
  return `<details class="map-legend" open><summary><span class="map-legend__label">${esc(label)}</span>` +
    `<span class="map-legend__unit">${esc(unit)}</span></summary><ul>${rows}</ul>${note}</details>`;
}
