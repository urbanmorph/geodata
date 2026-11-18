// @vitest-environment happy-dom
// /layers filters its rows from /layer-index.json (the rows no longer carry
// their search text). Until the index arrives every row stays visible, which
// is also the no-JS page; a ?q= arrival filters as soon as it lands.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/live-counts', () => ({ refreshLiveCounts: () => {} }));
vi.mock('../src/large-load', () => ({ markLargeViews: () => {} }));
vi.mock('../src/search-pop', () => ({ focusOnSlash: () => {} }));

const INDEX = [
  { i: 'lgd_districts', p: 'districts district', b: 'lgd boundaries', t: 'Districts', s: '785 districts', h: '/view/lgd_districts', n: 4 },
  { i: 'forest_cover', p: 'forest cover', b: 'fsi environment', t: 'Forest cover', s: 'x', h: '/view/forest_cover', n: 1 },
  { i: 'abcdefgh', p: 'lakes community submission', b: 'water', t: 'Lakes', s: 'community · geojson', h: '/c/abcdefgh' },
];

function page(): void {
  document.body.innerHTML = `
    <input id="catalog-search"><p id="search-meta"></p><p id="catalog-empty" hidden></p>
    <div id="catalog-grid">
      <section class="category-section" id="boundaries"><section class="row" id="district" data-id="lgd_districts" data-layers="4"></section></section>
      <section class="category-section" id="environment"><section class="row" id="forest" data-id="forest_cover" data-layers="1"></section></section>
      <section class="category-section" id="water"><article class="comm-card" data-id="abcdefgh"></article></section>
    </div>`;
}

const rows = () => [...document.querySelectorAll<HTMLElement>('.row, .comm-card')].map((el) => !el.classList.contains('hidden'));
const flush = () => new Promise((r) => setTimeout(r, 0));

let release: () => void;
beforeEach(() => {
  vi.resetModules();
  page();
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(url).toBe('/layer-index.json');
    await gate;
    return new Response(JSON.stringify(INDEX));
  }));
});

describe('/layers filter', () => {
  it('?q= keeps every row visible until the index arrives, then filters by it', async () => {
    history.replaceState(null, '', '/layers?q=forest');
    await import('../src/layers');
    expect((document.getElementById('catalog-search') as HTMLInputElement).value).toBe('forest');
    expect(rows()).toEqual([true, true, true]);
    release();
    await flush(); await flush();
    expect(rows()).toEqual([false, true, false]);
    expect(document.getElementById('boundaries')!.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('search-meta')!.textContent).toContain('forest');
  });

  it('typing loads the index once and filters; clearing shows every row again', async () => {
    history.replaceState(null, '', '/layers');
    await import('../src/layers');
    release();
    const input = document.getElementById('catalog-search') as HTMLInputElement;
    input.value = 'lakes';
    input.dispatchEvent(new Event('input'));
    await flush(); await flush();
    expect(rows()).toEqual([false, false, true]);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(rows()).toEqual([true, true, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
