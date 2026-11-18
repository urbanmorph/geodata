// Tiny entry: hash-based map routing + hover-prefetch of the map chunk.
// Map code is in a separate chunk; only loaded when the user opens a map.
import { isEmbedPath, isViewPath, nextStateOnClose, catalogVisibleOnLoad } from './embed-snippet';
import { filterCards, type CardLike, type LayerIndexEntry } from './catalog-filter';
import { openDialog, closeDialog } from './overlay-dialog';
import { refreshLiveCounts } from './live-counts';
import { showLayerError } from './layer-errors';
import { findMyWard } from './find-my-ward';
import { fetchWardIndex } from './ward-index';
import { rankHits, hitsHtml, moveActive, allLayersUrl, focusOnSlash, matchSummaryHtml, type Hit } from './search-pop';

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
  openDialog(overlay);
  document.body.style.overflow = 'hidden';
  try {
    const m = await loadMap();
    await m.openLayer(layerId, { titleEl: mapTitle });
  } catch (e) {
    // The map's own code is a separate download, and the catalog another: with no
    // connection they can't load, so say why instead of leaving "loading map…" up.
    showLayerError(document.getElementById('map')!, e);
  }
}

// Mirrors the prerendered <title> in web/index.html. If that changes,
// update here too — kept as a constant so tab-title restoration on map
// close doesn't depend on a meta tag or a server roundtrip.
const HOME_TITLE = "India's open atlas: every boundary, one search away · bharatlas";

async function hideMap() {
  // Hands focus back to what opened the map (or out of it) before hiding it.
  closeDialog(overlay);
  overlay.classList.remove('open');
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
// Escape closes what is open on the map first, and the map only when nothing is.
window.addEventListener('keydown', async (e) => {
  if (e.key !== 'Escape' || !overlay.classList.contains('open')) return;
  if (!(await loadMap()).closeTopSurface()) hideMap();
});
window.addEventListener('hashchange', handleHash);
handleHash();
if (viewProbe.view) { warmCatalog(); showMap(viewProbe.layerId); }

// The hero's India map: its theme switch is a small chunk of its own.
const indiaMap = document.querySelector<HTMLElement>('[data-india-map]');
if (indiaMap) void import('./india-map').then((m) => m.initIndiaMap(indiaMap));

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

// Home search: the results popover over /layer-index.json, one entry per
// /layers row (prerender builds it from those rows). Fetched the first time
// the search is focused or hovered, so the home page carries no list.
const searchInput = document.getElementById('catalog-search') as HTMLInputElement | null;
const searchMeta = document.getElementById('search-meta');
if (searchInput) {
  const pop = document.getElementById('search-pop');
  const resultsBox = document.getElementById('search-results');
  let cards: CardLike[] = [];
  let hits: Hit[] = [];
  let loading: Promise<void> | null = null;
  const loadIndex = (): Promise<void> =>
    (loading ??= fetch('/layer-index.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<LayerIndexEntry[]>;
      })
      .then((rows) => {
        cards = rows.map((r) => ({ primary: r.p, body: r.b, layers: r.n }));
        hits = rows.map((r) => ({ title: r.t, sub: r.s, href: r.h }));
      })
      .catch((e: unknown) => {
        loading = null; // retry on the next keystroke
        throw e;
      }));
  const warm = () => void loadIndex().catch(() => {});
  searchInput.addEventListener('focus', warm, { once: true });
  searchInput.closest('.search-wrap')?.addEventListener('pointerenter', warm, { once: true });

  let activeHit = -1;
  let query = '';
  const setPop = (open: boolean) => {
    if (!pop) return;
    pop.hidden = !open;
    searchInput.setAttribute('aria-expanded', String(open));
    if (!open) searchInput.removeAttribute('aria-activedescendant');
  };
  // innerHTML, not textContent: the idle line carries the #dl-total slot and its
  // emphasised count span, which a plain-text snapshot would flatten.
  const idleMeta = searchMeta?.innerHTML ?? '';

  const run = async (): Promise<void> => {
    query = searchInput.value.trim().toLowerCase();
    document.body.classList.toggle('searching', !!query);
    if (!query) {
      setPop(false);
      if (searchMeta) searchMeta.innerHTML = idleMeta;
      return;
    }
    const asked = query;
    try {
      await loadIndex();
    } catch {
      if (asked !== query) return; // cleared or retyped meanwhile
      if (resultsBox) resultsBox.innerHTML = `<p class="search-pop__head">Couldn't load the layer list. <a href="${allLayersUrl(searchInput.value.trim())}">Search all layers</a></p>`;
      setPop(true);
      return;
    }
    if (asked !== query) return; // a newer keystroke is running
    const { matches, totalMatches, totalLayers } = filterCards(cards, query);
    if (resultsBox) resultsBox.innerHTML = hitsHtml(rankHits(hits, matches, query, 6), { rows: totalMatches, layers: totalLayers }, searchInput.value.trim());
    activeHit = -1;
    searchInput.removeAttribute('aria-activedescendant');
    setPop(true);
    if (searchMeta) searchMeta.innerHTML = matchSummaryHtml(totalLayers, searchInput.value.trim());
  };

  searchInput.addEventListener('input', () => {
    void run();
    void showWardAnswer(searchInput.value);
  });

  // ?q=… support: required for the WebSite SearchAction in JSON-LD (Google's
  // sitelinks search box). Pre-fills the box and opens the results.
  const qParam = new URLSearchParams(location.search).get('q');
  if (qParam) {
    searchInput.value = qParam;
    void run();
    void showWardAnswer(qParam);
    searchInput.focus();
  }

  // Results popover: arrow keys move, Enter opens (or, with nothing picked,
  // shows every match on /layers), Esc closes; a click outside closes it;
  // "/" focuses search from anywhere on the page.
  searchInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // Enter / arrows belong to the IME while it composes (Hindi, Tamil...)
    const opts = Array.from(resultsBox?.querySelectorAll<HTMLAnchorElement>('.search-hit') ?? []);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!opts.length) return;
      e.preventDefault();
      setPop(true);
      activeHit = moveActive(activeHit, e.key, opts.length);
      opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === activeHit)));
      searchInput.setAttribute('aria-activedescendant', opts[activeHit].id);
      opts[activeHit].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeHit >= 0 && opts[activeHit]) location.assign(opts[activeHit].href);
      else if (query) location.assign(allLayersUrl(searchInput.value.trim()));
    } else if (e.key === 'Escape') {
      setPop(false);
    }
  });
  searchInput.addEventListener('focus', () => { if (query) setPop(true); });
  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest?.('.search-wrap')) setPop(false);
  });
  focusOnSlash(searchInput);
  // Quick searches ("Try: ...") run in place; without JS they are ?q= links.
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.quick-search a[data-q]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      searchInput.value = a.dataset.q || '';
      searchInput.dispatchEvent(new Event('input'));
      searchInput.focus();
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

if (catalogVisibleOnLoad(location.pathname)) refreshLiveCounts();
