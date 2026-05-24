// Tiny entry: hash-based map routing + hover-prefetch of the map chunk.
// Map code is in a separate chunk; only loaded when the user opens a map.
import { isEmbedPath, isViewPath, nextStateOnClose } from './embed-snippet';
import { filterCards, type CardLike } from './catalog-filter';

const overlay = document.getElementById('map-overlay')!;
const mapTitle = document.getElementById('map-title')!;
const mapCloseBtn = document.getElementById('map-close') as HTMLButtonElement;

// Dynamic imports are cached by the loader, so we don't need our own cache.
const loadMap = () => import('./map');

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
  const m = await loadMap();
  await m.openLayer(layerId, { titleEl: mapTitle });
}

// Mirrors the prerendered <title> in web/index.html. If that changes,
// update here too — kept as a constant so tab-title restoration on map
// close doesn't depend on a meta tag or a server roundtrip.
const HOME_TITLE = "India's open atlas · view, verify, contribute · bharatlas";

async function hideMap() {
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  (await loadMap()).closeLayer();
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
if (viewProbe.view) showMap(viewProbe.layerId);

// Hover/touchstart prefetch: warm the map chunk as soon as the user signals
// intent. Dynamic import() dedupes — fires once across all event sources.
const prefetch = () => {
  loadMap();
};
for (const a of document.querySelectorAll<HTMLAnchorElement>('a.btn-primary[href^="/view/"]')) {
  a.addEventListener('mouseenter', prefetch, { once: true, passive: true });
  a.addEventListener('touchstart', prefetch, { once: true, passive: true });
  a.addEventListener('focus', prefetch, { once: true });
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
  }));
  let activeCat = 'all';
  let query = '';
  const idleMeta = searchMeta?.textContent ?? '';

  const apply = () => {
    const result = filterCards(cardLikes, query);
    // When the user picks a category pill (or types a query), auto-expand
    // every section so the row--collapsed cap doesn't hide matches.
    const forceExpand = !!query || activeCat !== 'all';

    // Per-card visibility = matches query AND in active category.
    // Track per-section + total visible for section hide + meta line.
    const visiblePerSection = new Map<HTMLElement, number>();
    let totalVisible = 0;
    for (let i = 0; i < cardEls.length; i++) {
      const el = cardEls[i];
      const cat = cardLikes[i].category;
      const inCat = activeCat === 'all' || cat === activeCat;
      const visible = result.matches[i] && inCat;
      el.classList.toggle('hidden', !visible);
      if (visible) {
        totalVisible++;
        const sec = el.closest<HTMLElement>('.category-section');
        if (sec) visiblePerSection.set(sec, (visiblePerSection.get(sec) || 0) + 1);
      }
    }
    for (const section of sections) {
      section.classList.toggle('expanded', forceExpand);
      const cat = section.dataset.category || '';
      const sectionVisible = visiblePerSection.get(section) || 0;
      const catFiltered = activeCat !== 'all' && cat !== activeCat;
      section.classList.toggle('hidden', catFiltered || sectionVisible === 0);
    }

    // Pill counts: filtered/total when a query is active, bare total when idle.
    // 'all' chip aggregates across categories; per-cat chips read their own.
    const filtering = !!query;
    for (const chip of chips) {
      const cat = chip.dataset.cat || '';
      const total = Number(chip.dataset.total || '0');
      const filtered = cat === 'all'
        ? result.totalMatches
        : (result.countsByCategory.get(cat) || 0);
      const span = chip.querySelector<HTMLElement>('.count');
      if (span) span.textContent = filtering ? `${filtered}/${total}` : String(total);
      // data-count drives the [data-count="0"] dim style + click guard.
      chip.dataset.count = String(filtering ? filtered : total);
    }

    if (emptyMsg) emptyMsg.hidden = totalVisible > 0;
    if (searchMeta) {
      if (!query && activeCat === 'all') {
        searchMeta.textContent = idleMeta;
      } else if (query) {
        const q = searchInput.value.trim();
        searchMeta.textContent = `${totalVisible} match${totalVisible === 1 ? '' : 'es'} for "${q}"`;
      } else {
        const chip = chips.find((c) => c.dataset.cat === activeCat);
        const label = (chip?.firstChild?.textContent || activeCat).trim().toLowerCase();
        searchMeta.textContent = `${totalVisible} ${label} layer${totalVisible === 1 ? '' : 's'}`;
      }
    }
  };

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    apply();
  });

  // ?q=… support — required for the WebSite SearchAction in JSON-LD to be
  // honored by Google's sitelinks search box. Pre-fills the input and
  // applies the filter on first paint.
  const qParam = new URLSearchParams(location.search).get('q');
  if (qParam) {
    searchInput.value = qParam;
    query = qParam.trim().toLowerCase();
    apply();
    searchInput.focus();
  }
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      if (chip.dataset.count === '0') return;
      chips.forEach((c) => c.classList.toggle('active', c === chip));
      activeCat = chip.dataset.cat || 'all';
      apply();
    });
  }

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
