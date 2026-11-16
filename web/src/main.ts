// Tiny entry: hash-based map routing + hover-prefetch of the map chunk.
// Map code is in a separate chunk; only loaded when the user opens a map.
import { isEmbedPath, isViewPath, nextStateOnClose, shouldRestoreCategory, catalogVisibleOnLoad } from './embed-snippet';
import { filterCards, cardVisibility, type CardLike } from './catalog-filter';
import { blurFocusWithin } from './focus-utils';
import { fmtCount } from './format-hints';
import { showLayerError } from './layer-errors';
import { findMyWard } from './find-my-ward';
import { fetchWardIndex } from './ward-index';
import { rankHits, hitsHtml, moveActive, type Hit } from './search-pop';

// The crawler-only `.view-seo` article that /view/<id>'s Pages Function
// injects is NOT removed on hydrate — doing so shrank the body and was the
// dominant CLS source on /view/<id> pages (CWV poor). It sits behind the
// position:fixed map overlay. It IS removed when the user closes the overlay
// (see hideMap), otherwise it lingers above the catalog view once the URL is
// rewritten to '/'. That close-time removal is inside a user gesture, so it's
// excluded from CLS.

const overlay = document.getElementById('map-overlay')!;
const mapTitle = document.getElementById('map-title')!;
const mapCloseBtn = document.getElementById('map-close') as HTMLButtonElement;

// Re-applies the saved category filter. Assigned by the catalog block below
// (where the chips + apply() live). hideMap() calls it so closing the map
// returns you to your filtered catalog (breadcrumb) instead of "all".
let restoreSavedCategory: (() => void) | null = null;

// Dynamic imports are cached by the loader, so we don't need our own cache.
const loadMap = () => import('./map');
// Start the catalog fetch alongside the map chunk (the map needs both).
const warmCatalog = () => void import('./catalog').then((m) => m.getCatalog()).catch(() => {});

// /embed/<layerId>: Cloudflare Pages rewrites the path to /index.html, so the
// same bundle serves both contexts. Detect via the unrewritten URL.
{
  const probe = isEmbedPath(location.pathname);
  if (probe.embed) {
    document.body.classList.add('embed');
    // noindex duplicate embed pages; Google honors JS-set robots meta for
    // client-rendered pages.
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    if (!location.hash.startsWith('#view/')) {
      history.replaceState(null, '', `#view/${encodeURIComponent(probe.layerId)}`);
    }
  }
}

// /view/<layerId>: Cloudflare Pages Function (functions/view/[id].ts) serves
// the home HTML with per-layer og:image and JSON-LD Dataset baked in for
// social-card crawlers. Same browser bundle — open the layer directly
// without touching the URL so the canonical /view/<id> stays shareable.
const viewProbe = isViewPath(location.pathname);

async function showMap(layerId: string) {
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  let m: Awaited<ReturnType<typeof loadMap>>;
  try {
    m = await loadMap();
  } catch (e) {
    // The map's own code is a separate download: with no connection it can't load,
    // so say why instead of leaving "loading map…" up for good.
    showLayerError(document.getElementById('map')!, e);
    return;
  }
  await m.openLayer(layerId, { titleEl: mapTitle });
}

// Mirrors the prerendered <title> in web/index.html. If that changes,
// update here too — kept as a constant so tab-title restoration on map
// close doesn't depend on a meta tag or a server roundtrip.
const HOME_TITLE = "India's open atlas: every boundary, one search away · bharatlas";

async function hideMap() {
  // Re-apply the saved category filter BEFORE revealing the catalog, so closing
  // the map returns to the user's filtered view (breadcrumb), not "all", and
  // with no flash of the unfiltered grid. A close is a user gesture, so any
  // resulting shift is excluded from CLS — which is why we restore here rather
  // than on the /view/<id> load (that would shift content Chrome still counts).
  restoreSavedCategory?.();
  // Move focus out of the overlay BEFORE hiding it from assistive tech — closing
  // via #map-close leaves focus on a descendant, and aria-hidden on its ancestor
  // is blocked by the browser (see focus-utils).
  blurFocusWithin(overlay);
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  (await loadMap()).closeLayer();
  // The crawler-only SEO article (.view-seo, server-injected on /view/<id>)
  // must not linger above the catalog view once the map is closed and the URL
  // is rewritten back to '/'. Removing it here is inside a user gesture, so
  // it's excluded from CLS — unlike removing it on hydrate, which was the
  // CWV regression that made us stop touching it on load.
  document.querySelector('.view-seo')?.remove();
  refreshLiveCounts();
  // Snapshot location BEFORE any mutation. The earlier two-call version
  // (urlAfterCloseMap + replaceState, then titleAfterCloseMap) read the
  // post-mutation '/' pathname for the title decision and stuck the tab
  // title on the per-layer string.
  const next = nextStateOnClose(location.pathname, location.hash, location.search, HOME_TITLE);
  const current = location.pathname + location.hash + location.search;
  if (next.url !== current) {
    history.replaceState(null, '', next.url);
  }
  if (next.title !== null && next.title !== document.title) {
    document.title = next.title;
  }
}

function handleHash() {
  const m = location.hash.match(/^#view\/(.+)$/);
  if (m) {
    showMap(decodeURIComponent(m[1]));
  } else if (overlay.classList.contains('open')) {
    hideMap();
  }
}

mapCloseBtn.addEventListener('click', hideMap);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlay.classList.contains('open')) hideMap();
});
window.addEventListener('hashchange', handleHash);
handleHash();
if (viewProbe.view) { warmCatalog(); showMap(viewProbe.layerId); }

// Hover/touchstart prefetch: warm the map chunk as soon as the user signals
// intent. Dynamic import() dedupes — fires once across all event sources.
const prefetch = () => {
  loadMap();
  warmCatalog();
};
for (const a of document.querySelectorAll<HTMLAnchorElement>('a.btn-primary[href^="/view/"]')) {
  a.addEventListener('mouseenter', prefetch, { once: true, passive: true });
  a.addEventListener('touchstart', prefetch, { once: true, passive: true });
  a.addEventListener('focus', prefetch, { once: true });
}

// Home "Find my ward". Static import, not dynamic: the location must be
// requested synchronously in the tap or iOS drops it (find-my-ward.ts).
const findWardBtn = document.getElementById('find-my-ward');
const findWardStatus = document.getElementById('find-ward-status');
if (findWardBtn && findWardStatus) {
  const say = (message: string) => { findWardStatus.hidden = false; findWardStatus.textContent = message; };
  findWardBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) return say("Your browser can't share your location. Search your area instead.");
    findMyWard({ geolocation: navigator.geolocation, fetch: (url) => fetch(url), go: (url) => location.assign(url), say });
  });
}

// Answer-first search: "ward 9 ahmedabad" shows "Ward 9, Ahmedabad is
// Naranpura" above the results. The parser and city list load only once a
// query has "ward" and a number; each city's ward index is fetched once
// (ward-index.ts).
const wardBox = document.getElementById('ward-answer');
let wardSeq = 0;
async function showWardAnswer(raw: string): Promise<void> {
  if (!wardBox) return;
  const seq = ++wardSeq;
  let html = '';
  if (/ward/i.test(raw) && /\d/.test(raw)) {
    const m = await import('./ward-answer');
    const q = m.parseWardQuery(raw, m.wardCities());
    if (q) {
      const idx = await fetchWardIndex(q.layerId);
      const a = idx && m.wardAnswer(idx, q.number);
      if (a) html = m.wardAnswerHtml(q, a);
    }
  }
  if (seq !== wardSeq) return; // a newer keystroke owns the box
  wardBox.innerHTML = html;
  wardBox.hidden = !html;
}

// Catalog search + category filter (home page only).
// Operates on category sections + pre-rendered cards via data-* attributes.
// Pill click → show only that category section. Search → two-tier matcher
// (see catalog-filter.ts). Pill counts update live to filtered/total.
const searchInput = document.getElementById('catalog-search') as HTMLInputElement | null;
const grid = document.getElementById('catalog-grid');
const emptyMsg = document.getElementById('catalog-empty');
const searchMeta = document.getElementById('search-meta');
if (searchInput && grid) {
  const sections = Array.from(grid.querySelectorAll<HTMLElement>('.category-section'));
  const chips = Array.from(document.querySelectorAll<HTMLButtonElement>('.catalog-chip'));
  // One-time collection: every card across every section, paired with its
  // CardLike record for the pure filter and its DOM node for visibility
  // toggling. Order is preserved so the matches[] mask lines up.
  const cardEls = Array.from(grid.querySelectorAll<HTMLElement>('.row, .comm-card'));
  const cardLikes: CardLike[] = cardEls.map((el) => ({
    category: el.dataset.category || el.closest<HTMLElement>('.category-section')?.dataset.category || '',
    primary: el.dataset.searchPrimary || '',
    body: el.dataset.searchBody || '',
    provenance: el.dataset.provenance || '',
    layers: Number(el.dataset.layers) || 1,
  }));
  const cardSections = cardEls.map((el) => el.closest<HTMLElement>('.category-section'));
  // What the results popover shows for each card (prerender's data-title/-sub/-href).
  const cardHits: Hit[] = cardEls.map((el) => ({ title: el.dataset.title || '', sub: el.dataset.sub || '', href: el.dataset.href || '#layers' }));
  const pop = document.getElementById('search-pop');
  const resultsBox = document.getElementById('search-results');
  let activeHit = -1;
  const setPop = (open: boolean) => {
    if (!pop) return;
    pop.hidden = !open;
    searchInput.setAttribute('aria-expanded', String(open));
    if (!open) searchInput.removeAttribute('aria-activedescendant');
  };
  const renderPop = (matches: boolean[]) => {
    if (!resultsBox) return;
    if (!query) { setPop(false); return; }
    const hits = rankHits(cardHits, matches, query, 6);
    resultsBox.innerHTML = hitsHtml(hits, matches.filter(Boolean).length, searchInput.value.trim());
    activeHit = -1;
    searchInput.removeAttribute('aria-activedescendant');
    setPop(true);
  };
  let activeCat = 'all';
  let query = '';
  // innerHTML, not textContent: the idle line carries the #dl-total slot and its
  // emphasised count span, which a plain-text snapshot would flatten — so a
  // search-and-clear would strip the styling and the formatted total.
  const idleMeta = searchMeta?.innerHTML ?? '';

  const apply = () => {
    const result = filterCards(cardLikes, query);
    // When the user picks a category pill (or types a query), auto-expand
    // every section so the row--collapsed cap doesn't hide matches.
    const forceExpand = !!query || activeCat !== 'all';

    // Per-card visibility: search query intent overrides category-pill scope
    // (see cardVisibility doc-comment in catalog-filter.ts). When the user
    // is typing in the search box, every match across every category renders
    // — regardless of which pill is active — so cross-category results
    // ("over" → Overture in Infrastructure with Environment selected) don't
    // silently get hidden behind "No matches".
    const visible = cardVisibility(result.matches, cardLikes, activeCat, query);
    const visiblePerSection = new Map<HTMLElement, number>();
    let totalVisible = 0;
    let layersVisible = 0;
    for (let i = 0; i < cardEls.length; i++) {
      const el = cardEls[i];
      el.classList.toggle('hidden', !visible[i]);
      if (visible[i]) {
        totalVisible++;
        layersVisible += cardLikes[i].layers ?? 1;
        const sec = cardSections[i];
        if (sec) visiblePerSection.set(sec, (visiblePerSection.get(sec) || 0) + 1);
      }
    }
    for (const section of sections) {
      section.classList.toggle('expanded', forceExpand);
      const cat = section.dataset.category || '';
      const sectionVisible = visiblePerSection.get(section) || 0;
      // Hide a section only when (a) the user has scoped to a different pill
      // AND isn't searching, OR (b) it has no visible cards. While searching,
      // sections appear for every category that has matches.
      // 'community' is a provenance pill, not a content category — every
      // section that has at least one visible community card should show.
      // Existing rule covers that via sectionVisible === 0 below; we just
      // need to skip the category-mismatch hide.
      const catFiltered = !query && activeCat !== 'all' && activeCat !== 'community' && cat !== activeCat;
      section.classList.toggle('hidden', catFiltered || sectionVisible === 0);
    }

    // Pill counts: filtered/total when a query is active, bare total when idle.
    // 'all' chip aggregates across categories; per-cat chips read their own.
    const filtering = !!query;
    // 'community' chip's filtered count comes from provenance, not category;
    // filterCards groups countsByCategory under content categories so it
    // doesn't know about the community pill.
    const communityFiltered = result.matches.reduce(
      (n, m, i) => n + (m && cardLikes[i].provenance === 'community' ? 1 : 0), 0,
    );
    for (const chip of chips) {
      const cat = chip.dataset.cat || '';
      const total = Number(chip.dataset.total || '0');
      const filtered = cat === 'all'
        ? result.totalMatches
        : cat === 'community'
          ? communityFiltered
          : (result.countsByCategory.get(cat) || 0);
      const span = chip.querySelector<HTMLElement>('.count');
      if (span) span.textContent = filtering ? `${filtered}/${total}` : String(total);
      // data-count drives the [data-count="0"] dim style + click guard.
      chip.dataset.count = String(filtering ? filtered : total);
    }

    if (emptyMsg) emptyMsg.hidden = totalVisible > 0;
    // While searching, the results lead: themes and popular step aside.
    document.body.classList.toggle('searching', !!query);
    renderPop(result.matches);
    if (searchMeta) {
      if (!query && activeCat === 'all') {
        searchMeta.innerHTML = idleMeta;
      } else if (query) {
        const q = searchInput.value.trim();
        searchMeta.textContent = `${totalVisible} match${totalVisible === 1 ? '' : 'es'} for "${q}"`;
      } else {
        const chip = chips.find((c) => c.dataset.cat === activeCat);
        const label = (chip?.firstChild?.textContent || activeCat).trim().toLowerCase();
        searchMeta.textContent = `${layersVisible} ${label} layer${layersVisible === 1 ? '' : 's'}`;
      }
    }
  };

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    apply();
    void showWardAnswer(searchInput.value);
  });

  // ?q=… support — required for the WebSite SearchAction in JSON-LD to be
  // honored by Google's sitelinks search box. Pre-fills the input and
  // applies the filter on first paint.
  const qParam = new URLSearchParams(location.search).get('q');
  if (qParam) {
    searchInput.value = qParam;
    query = qParam.trim().toLowerCase();
    apply();
    void showWardAnswer(qParam);
    searchInput.focus();
  }
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      if (chip.dataset.count === '0') return;
      chips.forEach((c) => c.classList.toggle('active', c === chip));
      activeCat = chip.dataset.cat || 'all';
      try { sessionStorage.setItem('cat', activeCat); } catch {}
      apply();
      // A theme card filters the list below it: take the reader there.
      document.getElementById('layers')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
  }

  // Results popover: arrow keys move, Enter opens, Esc closes; a click
  // outside closes it; "/" focuses search from anywhere on the page.
  searchInput.addEventListener('keydown', (e) => {
    const opts = Array.from(resultsBox?.querySelectorAll<HTMLAnchorElement>('.search-hit') ?? []);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!opts.length) return;
      e.preventDefault();
      setPop(true);
      activeHit = moveActive(activeHit, e.key, opts.length);
      opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === activeHit)));
      searchInput.setAttribute('aria-activedescendant', opts[activeHit].id);
      opts[activeHit].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeHit >= 0 && opts[activeHit]) {
      e.preventDefault();
      location.assign(opts[activeHit].href);
    } else if (e.key === 'Escape') {
      setPop(false);
    }
  });
  searchInput.addEventListener('focus', () => { if (query) setPop(true); });
  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest?.('.search-wrap')) setPop(false);
  });
  pop?.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.search-pop__all')) setPop(false);
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key !== '/' || e.metaKey || e.ctrlKey || t.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    searchInput.focus();
  });
  // Quick searches ("Try: ...") run in place; without JS they are ?q= links.
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.quick-search a[data-q]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      searchInput.value = a.dataset.q || '';
      searchInput.dispatchEvent(new Event('input'));
      searchInput.focus();
    });
  }

  // Breadcrumb restore. Re-applies the saved category pill + filter. Used in
  // two CLS-safe spots: (a) here on a back/forward navigation (browser back to
  // the catalog — bfcache usually handles this, this is the fallback), and
  // (b) from hideMap() when the map overlay is closed (a user gesture). It is
  // deliberately NOT called on a fresh load or refresh, which keeps the first
  // paint shift-free for direct + search arrivals (the common case).
  restoreSavedCategory = () => {
    const saved = (() => { try { return sessionStorage.getItem('cat'); } catch { return null; } })();
    if (!saved || saved === 'all') return;
    const match = chips.find((c) => c.dataset.cat === saved);
    if (!match) return;
    chips.forEach((c) => c.classList.toggle('active', c === match));
    activeCat = saved;
    apply();
  };
  const navType = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type;
  const savedCat = (() => { try { return sessionStorage.getItem('cat'); } catch { return null; } })();
  if (shouldRestoreCategory(navType, savedCat)) restoreSavedCategory();

  // "show all N <category>" toggle inside dense category sections.
  // Toggles `.expanded` on the parent <section>; CSS in index.template.html
  // reveals/hides .row--collapsed children. The button hides itself when
  // expanded. Also fires automatically when a category pill picks this
  // section (so filtered views show everything).
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-show-more]')) {
    btn.addEventListener('click', () => {
      const section = btn.closest('.category-section');
      if (!section) return;
      section.classList.add('expanded');
      btn.setAttribute('aria-expanded', 'true');
    });
  }
}

// Drag-anywhere on the home page → stash file via the existing handoff and
// navigate to /verify. The 📎 button is a plain anchor — click works for
// users who want to navigate without dragging.
{
  let dragDepth = 0;
  const hasFiles = (dt: DataTransfer | null) =>
    !!dt && Array.from(dt.types || []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e.dataTransfer)) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('is-dragging');
    }
  });
  window.addEventListener('drop', async (e) => {
    const dt = e.dataTransfer;
    // Diagnostic breadcrumbs are deliberate. Removing them has historically
    // re-introduced an intermittent home→verify handoff bug in real browsers
    // (works in headless e2e, breaks in actual Chrome). Don't strip without
    // a replacement diagnostic and a soak test against the real flow.
    console.log('[home] drop fired · files:', dt?.files?.length, '· types:', dt && Array.from(dt.types));
    if (!dt?.files.length) return;
    e.preventDefault();
    document.body.classList.remove('is-dragging');
    dragDepth = 0;
    const file = dt.files[0];
    console.log('[home] file:', file.name, file.size, file.type);
    try {
      const { stashForSubmit } = await import('./handoff');
      await stashForSubmit(file);
      console.log('[home] stashed · sessionStorage:', sessionStorage.getItem('geodata:handoff'));
    } catch (err) {
      console.error('[home] handoff stash failed', err);
    }
    console.log('[home] → /preview');
    location.assign('/preview');
  });
}

// Live download counts and useful votes: fetched from D1 so badges are
// always current (no catalog.json drift); baked values remain if a fetch
// fails. Only where the catalog shows: on load on the home page, and on
// /view once the map is closed (hideMap). Embeds never show it.
let liveCountsRequested = false;
function refreshLiveCounts(): void {
  if (liveCountsRequested) return;
  liveCountsRequested = true;
  fetch('/api/dl/counts')
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, Record<string, number> | number>>) : null))
    .then((counts) => {
      if (!counts) return;

      // Patch per-format badges: <span class="count" title="N downloads">N</span>
      // Each download link lives inside a card with data-id="<layer_id>" and
      // the link text is the format name (parquet, geojson, kml, shp).
      // fmtCount lives in format-hints.ts (pure + unit-tested).
      for (const section of document.querySelectorAll<HTMLElement>('[data-id]')) {
        const layerId = section.dataset.id || '';
        const layerCounts = counts[layerId] as Record<string, number> | undefined;
        if (!layerCounts) continue;
        for (const link of section.querySelectorAll<HTMLAnchorElement>('a[download]')) {
          const fmt = link.textContent?.trim() || '';
          const n = layerCounts[fmt];
          if (!n) continue;
          const badge = link.nextElementSibling?.nextElementSibling;
          if (badge?.classList.contains('count')) {
            badge.setAttribute('title', `${n.toLocaleString('en-IN')} downloads`);
            badge.textContent = fmtCount(n);
          } else {
            // No badge yet (was 0 at bake time) — inject one.
            const span = document.createElement('span');
            span.className = 'count';
            span.title = `${n.toLocaleString('en-IN')} downloads`;
            span.textContent = fmtCount(n);
            // Insert after the size span (link → size-span → count-span)
            const sizeSpan = link.nextElementSibling;
            if (sizeSpan) sizeSpan.insertAdjacentElement('afterend', span);
          }
        }
      }

      // Refill the search-meta running total from the live count. The baked value
      // is a build-time snapshot; #dl-total is its own slot so we replace just the
      // " · <count> downloads" tail without touching the static prefix. The count
      // is built from a number, so innerHTML here is safe (no user input).
      const total = typeof counts._total === 'number' ? counts._total : 0;
      const slot = document.getElementById('dl-total');
      if (slot && total > 0) {
        slot.innerHTML = ` · <span class="search-meta__count">${fmtCount(total)}</span> downloads`;
      }
    })
    .catch(() => {});

  // Useful votes on community cards: patches each .comm-card's 👍 N span so
  // newly cast votes show without waiting for the next prerender. Missing
  // entries mean 0 votes; leave the baked default alone.
  fetch('/api/c/useful-counts')
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, number>>) : null))
    .then((counts) => {
      if (!counts) return;
      for (const card of document.querySelectorAll<HTMLElement>('.comm-card[data-id]')) {
        const id = card.dataset.id || '';
        const n = counts[id];
        if (n == null) continue;
        card.dataset.useful = String(n);
        const span = card.querySelector<HTMLElement>('.useful');
        if (span) span.textContent = `👍 ${n}`;
        const score = card.querySelector<HTMLElement>('.comm-card__score');
        if (score) score.title = `${n} found this useful`;
      }
    })
    .catch(() => {});
}
if (catalogVisibleOnLoad(location.pathname)) refreshLiveCounts();
