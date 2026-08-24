// Browse-all reference-layer picker, shared by the create form and Edit settings.
// The catalogue has ~100 overlay-able curated layers; this fetches them once and
// lets the author browse them grouped by category (or filter by typing), instead
// of the old "type a keyword, see the top 8". DOM + fetch only — no map deps, so
// the create form (landing entry) stays light.
import { listLayers, type RefLayer } from './catalog';
import { escapeHtml } from '../util';

const CAT_LABEL: Record<string, string> = {
  boundaries: 'Boundaries', 'city-wards': 'City wards', people: 'People', water: 'Water',
  transport: 'Transport', environment: 'Environment', infrastructure: 'Infrastructure',
  'health-edu': 'Health & education', agriculture: 'Agriculture', other: 'Other',
};

// Wire a search input + a results container into a browse-all picker. `onPick`
// receives the chosen layer. Layers load lazily on first focus/typing.
export function mountLayerPicker(search: HTMLInputElement, results: HTMLElement, onPick: (l: RefLayer) => void): void {
  let all: RefLayer[] = [];
  let loaded = false;

  const render = (q: string): void => {
    const ql = q.trim().toLowerCase();
    const filt = ql ? all.filter((l) => l.id.toLowerCase().includes(ql) || l.category.toLowerCase().includes(ql)) : all;
    if (!filt.length) { results.innerHTML = '<p class="hint">No layers match.</p>'; return; }
    const groups = new Map<string, RefLayer[]>();
    for (const l of filt) {
      const g = groups.get(l.category) ?? [];
      if (!g.length) groups.set(l.category, g);
      g.push(l);
    }
    results.innerHTML = [...groups.entries()]
      .map(([cat, ls]) =>
        `<div class="ref-cat">${escapeHtml(CAT_LABEL[cat] || cat)}</div>` +
        ls.map((l) => `<button type="button" class="ref-opt" data-id="${escapeHtml(l.id)}">${escapeHtml(l.label)}</button>`).join(''))
      .join('');
    results.querySelectorAll<HTMLButtonElement>('.ref-opt').forEach((b) => {
      b.onclick = () => { const l = all.find((x) => x.id === b.dataset.id); if (l) onPick(l); };
    });
  };

  const ensure = async (): Promise<void> => {
    if (loaded) { render(search.value); return; }
    results.innerHTML = '<p class="hint">Loading layers…</p>';
    try { all = await listLayers(); loaded = true; } catch { results.innerHTML = "<p class=\"hint\">Couldn't reach the catalogue, try again.</p>"; return; }
    render(search.value);
  };

  search.addEventListener('focus', () => void ensure());
  search.oninput = () => void ensure();
}
