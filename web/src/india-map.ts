// The home map's theme switch. The ward theme ships in the page; the other four
// come from /map-themes.json (scripts/build_map_themes.py), fetched once, the
// first time someone picks one of them.

export type MapTheme = { kind: 'line' | 'dense'; paths: string[] };

/** SVG for one fetched theme: a stroked line, or four shades of hexagons (lightest first). */
export function themeMarkup(theme: MapTheme, key: string): string {
  if (theme.kind === 'line') return `<path class="india-map__line india-map__line--${key}" d="${theme.paths[0]}"/>`;
  return theme.paths
    .map((d, i) => `<path class="india-map__dense india-map__dense--${key} india-map__shade--${i}" d="${d}"/>`)
    .join('');
}

let themes: Promise<Record<string, MapTheme>> | null = null;
function loadThemes(): Promise<Record<string, MapTheme>> {
  if (themes) return themes;
  const load: Promise<Record<string, MapTheme>> = fetch('/map-themes.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<Record<string, MapTheme>>;
    })
    .catch((e: unknown) => {
      themes = null; // a failed fetch may be retried on the next pick
      throw e;
    });
  themes = load;
  return load;
}

export function initIndiaMap(root: HTMLElement): void {
  const layer = root.querySelector<SVGGElement>('[data-map-layer]');
  const caption = root.querySelector<HTMLElement>('[data-map-caption]');
  const chips = [...root.querySelectorAll<HTMLButtonElement>('[data-map-theme]')];
  if (!layer || !caption) return;
  const wards = layer.innerHTML;
  let current = 'wards';

  const show = async (chip: HTMLButtonElement): Promise<void> => {
    const key = chip.dataset.mapTheme!;
    current = key;
    for (const c of chips) c.setAttribute('aria-pressed', String(c === chip));
    if (key === 'wards') {
      layer.innerHTML = wards;
      caption.textContent = chip.dataset.caption ?? '';
      return;
    }
    caption.textContent = `Loading ${chip.textContent?.toLowerCase()}…`;
    try {
      const data = await loadThemes();
      if (current !== key) return; // another chip was picked meanwhile
      if (!data[key]) {
        caption.textContent = "This map isn't available right now.";
        return;
      }
      layer.innerHTML = `<g clip-path="url(#india-clip)">${themeMarkup(data[key], key)}</g>`;
      caption.textContent = chip.dataset.caption ?? '';
    } catch {
      if (current === key) caption.textContent = "Couldn't load this map. Check your connection and try again.";
    }
  };
  for (const chip of chips) chip.addEventListener('click', () => void show(chip));
}
