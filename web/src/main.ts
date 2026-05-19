// Tiny entry: hash-based map routing + hover-prefetch of the map chunk.
// Map code is in a separate chunk; only loaded when the user opens a map.

const overlay = document.getElementById('map-overlay')!;
const mapTitle = document.getElementById('map-title')!;
const mapCloseBtn = document.getElementById('map-close') as HTMLButtonElement;

// Dynamic imports are cached by the loader, so we don't need our own cache.
const loadMap = () => import('./map');

async function showMap(layerId: string) {
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  const m = await loadMap();
  await m.openLayer(layerId, { titleEl: mapTitle });
}

async function hideMap() {
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  (await loadMap()).closeLayer();
  if (location.hash.startsWith('#view/')) {
    history.replaceState(null, '', location.pathname + location.search);
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

// Hover/touchstart prefetch: warm the map chunk as soon as the user signals
// intent. Dynamic import() dedupes — fires once across all event sources.
const prefetch = () => {
  loadMap();
};
for (const a of document.querySelectorAll<HTMLAnchorElement>('a.btn-primary[href^="#view/"]')) {
  a.addEventListener('mouseenter', prefetch, { once: true, passive: true });
  a.addEventListener('touchstart', prefetch, { once: true, passive: true });
  a.addEventListener('focus', prefetch, { once: true });
}
