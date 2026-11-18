// /layers: every layer, one section per theme (Option B). The box filters rows
// across every theme with the same matcher as the home search (catalog-filter),
// over the same /layer-index.json (the rows carry no search text of their own);
// "show all N" opens a long section; ?q= pre-fills the box.
import { filterCards, matchLine, type CardLike, type LayerIndexEntry } from './catalog-filter';
import { refreshLiveCounts } from './live-counts';
import { focusOnSlash } from './search-pop';
import { markLargeViews } from './large-load';

refreshLiveCounts();
markLargeViews(document);

const input = document.getElementById('catalog-search') as HTMLInputElement | null;
const grid = document.getElementById('catalog-grid');
const empty = document.getElementById('catalog-empty');
const meta = document.getElementById('search-meta');

if (input && grid) {
  const sections = Array.from(grid.querySelectorAll<HTMLElement>('.category-section'));
  const cardEls = Array.from(grid.querySelectorAll<HTMLElement>('.row, .comm-card'));
  const sectionOf = cardEls.map((el) => el.closest<HTMLElement>('.category-section'));

  // The haystacks, matched to the rows by id once the index arrives. Until
  // then (and without JS) every row stays visible.
  let cards: CardLike[] | null = null;
  let loading: Promise<void> | null = null;
  const loadIndex = (): Promise<void> =>
    (loading ??= fetch('/layer-index.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<LayerIndexEntry[]>;
      })
      .then((rows) => {
        const byId = new Map(rows.map((r) => [r.i, r]));
        cards = cardEls.map((el) => {
          const e = byId.get(el.dataset.id || '');
          return { primary: e?.p ?? '', body: e?.b ?? '', layers: e?.n };
        });
      })
      .catch((e: unknown) => {
        loading = null; // retry on the next keystroke
        throw e;
      }));

  const apply = (): void => {
    const query = input.value.trim();
    if (query && !cards) {
      // q-precheck.js has opened every section for a ?q= arrival: it stays so until the index lands.
      loadIndex().then(apply, () => {});
      return;
    }
    // q-precheck.js opened every section before paint for a ?q= arrival; from
    // here the filter owns that state, so clearing it collapses them again.
    document.documentElement.classList.remove('has-query');
    const result = query && cards ? filterCards(cards, query) : null;
    const perSection = new Map<HTMLElement, number>();
    cardEls.forEach((el, i) => {
      const match = result ? result.matches[i] : true;
      el.classList.toggle('hidden', !match);
      const sec = sectionOf[i];
      if (match && sec) perSection.set(sec, (perSection.get(sec) ?? 0) + 1);
    });
    for (const sec of sections) {
      // While filtering every match shows: open the section, hide empty ones.
      sec.classList.toggle('expanded', !!query);
      sec.classList.toggle('hidden', (perSection.get(sec) ?? 0) === 0);
    }
    if (empty) empty.hidden = !result || result.totalMatches > 0;
    if (meta) meta.textContent = result ? matchLine(result.totalLayers, query) : '';
  };

  const warm = () => void loadIndex().catch(() => {});
  input.addEventListener('focus', warm, { once: true });
  input.addEventListener('input', apply);
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    input.value = q;
    apply();
  }
  focusOnSlash(input);
  for (const btn of grid.querySelectorAll<HTMLButtonElement>('[data-show-more]')) {
    btn.addEventListener('click', () => {
      btn.closest('.category-section')?.classList.add('expanded');
      btn.setAttribute('aria-expanded', 'true');
    });
  }
}
