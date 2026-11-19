// /layers: every layer, one section per theme (Option B). The box filters rows
// across every theme with the same matcher as the home search (catalog-filter),
// over the same /layer-index.json (the rows carry no search text of their own);
// "show all N" opens a long section; ?q= pre-fills the box.
import { fetchLayerIndex, filterCards, layersPerGroup, matchLine, type CardLike } from './catalog-filter';
import { escapeHtml } from './util';
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
  // Each theme's count, in its section header and the theme index: the page's
  // own figure, or while filtering the number of its layers that match.
  const countEls = sections.map((sec) => ({
    head: sec.querySelector<HTMLElement>('.category-section__count'),
    index: document.querySelector<HTMLElement>(`.theme-index a[href="#${sec.id}"]`),
  }));
  const baked = countEls.map(({ head, index }) => ({
    head: head?.textContent ?? '',
    index: index?.querySelector('.theme-index__n')?.textContent ?? '',
  }));
  const showCounts = (perSection: Map<HTMLElement | null, number> | null): void => {
    sections.forEach((sec, i) => {
      const { head, index } = countEls[i];
      const n = perSection ? perSection.get(sec) ?? 0 : null;
      if (head) head.textContent = n == null ? baked[i].head : `${n} layer${n === 1 ? '' : 's'}`;
      const num = index?.querySelector('.theme-index__n');
      if (num) num.textContent = n == null ? baked[i].index : String(n);
      index?.classList.toggle('is-empty', n === 0);
    });
  };
  const showEmpty = (query: string | null): void => {
    if (!empty) return;
    empty.hidden = query == null;
    if (query == null) return;
    empty.innerHTML = `No layers match "${escapeHtml(query)}". Try a place or theme, or ` +
      `<button type="button" class="link-btn" data-clear-search>clear the search</button>. ` +
      `<a href="/preview">Contribute a layer</a>`;
    empty.querySelector('[data-clear-search]')?.addEventListener('click', () => {
      input.value = '';
      apply();
      input.focus();
    });
  };

  // The haystacks, matched to the rows by id once the index arrives. Until
  // then (and without JS) every row stays visible.
  let cards: CardLike[] | null = null;
  const loadIndex = (): Promise<void> =>
    fetchLayerIndex().then((rows) => {
      if (cards) return;
      const byId = new Map(rows.map((r) => [r.i, r]));
      cards = cardEls.map((el) => {
        const e = byId.get(el.dataset.id || '');
        return { primary: e?.p ?? '', body: e?.b ?? '', layers: e?.n };
      });
    });

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
    const matches = result ? result.matches : cardEls.map(() => true);
    cardEls.forEach((el, i) => el.classList.toggle('hidden', !matches[i]));
    // Layers per section: a row counts its layers (a level's alternates too).
    const perSection = layersPerGroup(cards ?? cardEls.map(() => ({ primary: '', body: '' })), matches, (i) => sectionOf[i]);
    for (const sec of sections) {
      // While filtering every match shows: open the section, hide empty ones.
      sec.classList.toggle('expanded', !!query);
      sec.classList.toggle('hidden', !perSection.get(sec));
    }
    showCounts(result ? perSection : null);
    showEmpty(result && result.totalMatches === 0 ? query : null);
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
