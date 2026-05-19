// Tiny entry: hash-based map routing. No framework, no filters.
// Map code is in a separate chunk; only loaded when the user opens a map.

const overlay = document.getElementById('map-overlay')!;
const mapTitle = document.getElementById('map-title')!;
const mapCloseBtn = document.getElementById('map-close') as HTMLButtonElement;

let mapModule: typeof import('./map') | null = null;

async function showMap(layerId: string) {
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (!mapModule) {
    mapModule = await import('./map');
  }
  await mapModule.openLayer(layerId, { titleEl: mapTitle });
}

function hideMap() {
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  mapModule?.closeLayer();
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
