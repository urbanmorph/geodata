// The home map: a picture of what the layers hold, not a working map. Each
// visit draws 2 or 3 themes picked at random and names them in the caption.
// The ward theme ships in the page (and is what shows without JS); the other
// four come from /map-themes.json (scripts/build_map_themes.py).

import { escapeHtml } from './util';

export type MapTheme = { kind: 'line' | 'dense'; paths: string[] };
/** A theme as the page carries it (scripts/india-map.mjs mapThemes). */
export type ThemeInfo = { key: string; name: string; href: string; caption?: string };

/** Themes drawn as shaded hexagons over the whole country: two would muddle each other. */
export const DENSE = new Set(['schools', 'forests']);

/** SVG for one fetched theme: a stroked line, or four shades of hexagons (lightest first). */
export function themeMarkup(theme: MapTheme, key: string): string {
  if (theme.kind === 'line') return `<path class="india-map__line india-map__line--${key}" d="${theme.paths[0]}"/>`;
  return theme.paths
    .map((d, i) => `<path class="india-map__dense india-map__dense--${key} india-map__shade--${i}" d="${d}"/>`)
    .join('');
}

// Lines vanish into shaded hexagons: a hexagon theme goes only with the ward
// markers, which are drawn on top of it.
const clash = (a: ThemeInfo, b: ThemeInfo) =>
  (DENSE.has(a.key) && b.key !== 'wards') || (DENSE.has(b.key) && a.key !== 'wards');

/**
 * 2 or 3 themes at random, in draw order (hexagons, lines, wards on top), kept
 * legible at the map's size: a hexagon theme comes only as a pair with the wards.
 */
export function pickThemes(all: ThemeInfo[], random: () => number = Math.random): ThemeInfo[] {
  const pool = [...all];
  const picked: ThemeInfo[] = [];
  let n = random() < 0.5 ? 2 : 3;
  while (picked.length < n && pool.length) {
    const [t] = pool.splice(Math.floor(random() * pool.length), 1);
    if (picked.some((p) => clash(p, t)) || (DENSE.has(t.key) && picked.length > 1)) continue;
    picked.push(t);
    if (DENSE.has(t.key)) n = 2;
  }
  const rank = (t: ThemeInfo) => (DENSE.has(t.key) ? 0 : t.key === 'wards' ? 2 : 1);
  return picked.sort((a, b) => rank(a) - rank(b));
}

/** "Showing: a, b and c", each linked to its layer's map. */
export function captionHtml(shown: ThemeInfo[]): string {
  const links = shown.map((t) =>
    `<a href="${escapeHtml(t.href)}"${t.caption ? ` title="${escapeHtml(t.caption)}"` : ''}>${escapeHtml(t.name)}</a>`);
  return `Showing: ${links.length > 1 ? `${links.slice(0, -1).join(', ')} and ${links[links.length - 1]}` : links[0]}`;
}

/** The map layer for the picked themes, or null if a theme's data is missing. */
export function layerMarkup(shown: ThemeInfo[], data: Record<string, MapTheme>, wardsSvg: string): string | null {
  const fetched = shown.filter((t) => t.key !== 'wards');
  if (fetched.some((t) => !data[t.key])) return null;
  const clipped = fetched.map((t) => themeMarkup(data[t.key], t.key)).join('');
  return `<g clip-path="url(#india-clip)">${clipped}</g>${shown.some((t) => t.key === 'wards') ? wardsSvg : ''}`;
}

export function initIndiaMap(root: HTMLElement): void {
  const layer = root.querySelector<SVGGElement>('[data-map-layer]');
  const caption = root.querySelector<HTMLElement>('[data-map-caption]');
  const wardsSvg = layer?.querySelector('.india-map__wards')?.outerHTML ?? '';
  let all: ThemeInfo[] = [];
  try { all = JSON.parse(root.dataset.themes || '[]'); } catch { /* keep the default */ }
  if (!layer || !caption || !all.length) return;
  const shown = pickThemes(all);
  // A failed fetch keeps the default (city wards), which the caption already names.
  void fetch('/map-themes.json')
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, MapTheme>>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data) => {
      const svg = layerMarkup(shown, data, wardsSvg);
      if (svg === null) return;
      layer.innerHTML = svg;
      caption.innerHTML = captionHtml(shown);
    })
    .catch(() => {});
}
