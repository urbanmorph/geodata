// /layers: every layer, one section per theme (Option B). The box filters rows
// across every theme with the same matcher as the home search (catalog-filter);
// "show all N" opens a long section; ?q= pre-fills the box.
import { filterCards, matchLine, type CardLike } from './catalog-filter';
import { refreshLiveCounts } from './live-counts';
import { focusOnSlash } from './search-pop';

refreshLiveCounts();

const input = document.getElementById('catalog-search') as HTMLInputElement | null;
const grid = document.getElementById('catalog-grid');
const empty = document.getElementById('catalog-empty');
const meta = document.getElementById('search-meta');

if (input && grid) {
  const sections = Array.from(grid.querySelectorAll<HTMLElement>('.category-section'));
  const cardEls = Array.from(grid.querySelectorAll<HTMLElement>('.row, .comm-card'));
  const cards: CardLike[] = cardEls.map((el) => ({
    primary: el.dataset.searchPrimary || '',
    body: el.dataset.searchBody || '',
    layers: Number(el.dataset.layers) || 1,
  }));
  const sectionOf = cardEls.map((el) => el.closest<HTMLElement>('.category-section'));

  const apply = (): void => {
    const query = input.value.trim();
    // q-precheck.js opened every section before paint for a ?q= arrival; from
    // here the filter owns that state, so clearing it collapses them again.
    document.documentElement.classList.remove('has-query');
    const { matches, totalMatches, totalLayers } = filterCards(cards, query);
    const perSection = new Map<HTMLElement, number>();
    cardEls.forEach((el, i) => {
      el.classList.toggle('hidden', !matches[i]);
      const sec = sectionOf[i];
      if (matches[i] && sec) perSection.set(sec, (perSection.get(sec) ?? 0) + 1);
    });
    for (const sec of sections) {
      // While filtering every match shows: open the section, hide empty ones.
      sec.classList.toggle('expanded', !!query);
      sec.classList.toggle('hidden', (perSection.get(sec) ?? 0) === 0);
    }
    if (empty) empty.hidden = totalMatches > 0;
    if (meta) meta.textContent = query ? matchLine(totalLayers, query) : '';
  };

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
