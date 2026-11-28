// /layers: every layer, in three realms (below ground, on the ground, in the
// air) with a section per theme in each (Option B). The box filters rows
// across every theme with the same matcher as the home search (catalog-filter),
// over the same /layer-index.json (the rows carry no search text of their own);
// "show all N" opens a long section; ?q= pre-fills the box.
import { requestLayerUrl } from '../../shared/requested-by.mjs';
import { fetchLayerIndex, filterCards, layersPerGroup, matchLine, type CardLike } from './catalog-filter';
import { escapeHtml } from './util';
import { refreshLiveCounts } from './live-counts';
import { focusOnSlash } from './search-pop';
import { markLargeViews } from './large-load';
import { wireLazyDownloads } from './layer-downloads';

refreshLiveCounts();
markLargeViews(document);

const input = document.getElementById('catalog-search') as HTMLInputElement | null;
const grid = document.getElementById('catalog-grid');
const empty = document.getElementById('catalog-empty');
const meta = document.getElementById('search-meta');
const strip = document.getElementById('requested');
// Each row's download links load when it opens (layer-downloads.ts).
if (grid) wireLazyDownloads(grid);

if (input && grid) {
  const sections = Array.from(grid.querySelectorAll<HTMLElement>('.category-section'));
  // Realms (below ground, on the ground, in the air) hold the theme sections.
  const realms = Array.from(grid.querySelectorAll<HTMLElement>('.realm'));
  const cardEls = Array.from(grid.querySelectorAll<HTMLElement>('.row, .comm-card'));
  const sectionOf = cardEls.map((el) => el.closest<HTMLElement>('.category-section'));
  // Each theme's and realm's count, in its section header (themes only) and
  // the index: the page's own figure, or while filtering the number of its
  // layers that match.
  const groups = [...sections, ...realms];
  const countEls = groups.map((g) => ({
    head: g.classList.contains('category-section') ? g.querySelector<HTMLElement>('.category-section__count') : null,
    index: document.querySelector<HTMLElement>(`.theme-index a[href="#${g.id}"]`),
  }));
  const baked = countEls.map(({ head, index }) => ({
    head: head?.textContent ?? '',
    index: index?.querySelector('.theme-index__n')?.textContent ?? '',
  }));
  const showCounts = (perGroup: Map<HTMLElement | null, number> | null): void => {
    groups.forEach((sec, i) => {
      const { head, index } = countEls[i];
      const n = perGroup ? perGroup.get(sec) ?? 0 : null;
      if (head) head.textContent = n == null ? baked[i].head : `${n} layer${n === 1 ? '' : 's'}`;
      const num = index?.querySelector('.theme-index__n');
      if (num) num.textContent = n == null ? baked[i].index : String(n);
      index?.classList.toggle('is-empty', n === 0);
    });
  };
  // Desktop index: every realm, but only the themes of the one in view (the
  // CSS keys off .is-following + .is-active). Every realm stays open while
  // searching, and without IntersectionObserver (or JS). No animation.
  const nav = document.querySelector<HTMLElement>('.theme-index');
  const follow = !!nav && realms.length > 0 && typeof IntersectionObserver === 'function';
  const groupOf = (id: string) => nav?.querySelector(`a[href="#${id}"]`)?.closest('.theme-index__group');
  const activate = (g: Element | null | undefined): void => {
    if (!g || g.classList.contains('is-active')) return;
    nav?.querySelector('.theme-index__group.is-active')?.classList.remove('is-active');
    g.classList.add('is-active');
  };
  if (follow) {
    activate(groupOf(realms[0].id));
    nav.classList.add('is-following');
    // The realm crossing a band a third of the way down the window is the one in view.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) activate(groupOf(e.target.id));
    }, { rootMargin: '-30% 0px -60% 0px' });
    for (const r of realms) io.observe(r);
    // Keyboard: tabbing onto a realm opens its themes.
    nav.addEventListener('focusin', (e) => activate((e.target as Element).closest('.theme-index__group')));
  }

  const showEmpty = (query: string | null): void => {
    if (!empty) return;
    empty.hidden = query == null;
    if (query == null) return;
    empty.innerHTML = `No layers match "${escapeHtml(query)}". Try a place or theme, or ` +
      `<button type="button" class="link-btn" data-clear-search>clear the search</button>. ` +
      `<a href="/preview">Contribute a layer</a> or <a href="${escapeHtml(requestLayerUrl(query))}">Request this layer</a>`;
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
    nav?.classList.toggle('is-following', follow && !query);
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
      // A realm's count is its sections' sum; a realm with no match hides.
      const realm = sec.closest<HTMLElement>('.realm');
      if (realm) perSection.set(realm, (perSection.get(realm) ?? 0) + (perSection.get(sec) ?? 0));
    }
    for (const realm of realms) realm.hidden = !perSection.get(realm);
    // The requested layers at the top are a starting point: a search shows only its matches.
    if (strip) strip.hidden = !!query;
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
