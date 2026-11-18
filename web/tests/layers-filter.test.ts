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

// While a query is active the theme counts say how many layers match (audit
// M10), and a search with no match offers a way back (audit L9).
describe('/layers filter: counts and the empty state', () => {
  const type = async (q: string) => {
    const input = document.getElementById('catalog-search') as HTMLInputElement;
    input.value = q;
    input.dispatchEvent(new Event('input'));
    await flush(); await flush();
  };
  const sectionCount = (id: string) => document.querySelector(`#${id} .category-section__count`)!.textContent;
  const indexCount = (id: string) => document.querySelector(`.theme-index a[href="#${id}"] .theme-index__n`)!.textContent;

  beforeEach(() => {
    page();
    document.querySelector('#catalog-grid')!.insertAdjacentHTML('beforebegin', `<nav class="theme-index">
      <a href="#boundaries"><span>Boundaries</span><span class="theme-index__n">26</span></a>
      <a href="#environment"><span>Environment</span><span class="theme-index__n">13</span></a>
      <a href="#water"><span>Water</span><span class="theme-index__n">9</span></a></nav>`);
    for (const [id, n] of [['boundaries', 26], ['environment', 13], ['water', 9]] as const) {
      document.getElementById(id)!.insertAdjacentHTML('afterbegin', `<header class="category-section__head"><span class="category-section__count">${n} layers</span></header>`);
    }
    history.replaceState(null, '', '/layers');
  });

  it('shows matched counts per theme, dims themes with none, and restores them when cleared', async () => {
    await import('../src/layers');
    release();
    await type('district');
    expect(sectionCount('boundaries')).toBe('4 layers');
    expect(indexCount('boundaries')).toBe('4');
    expect(indexCount('environment')).toBe('0');
    expect(document.querySelector('.theme-index a[href="#environment"]')!.classList.contains('is-empty')).toBe(true);
    await type('');
    expect(sectionCount('boundaries')).toBe('26 layers');
    expect(indexCount('environment')).toBe('13');
    expect(document.querySelector('.theme-index a.is-empty')).toBeNull();
  });

  it('a search with no match names the query and offers to clear it', async () => {
    await import('../src/layers');
    release();
    await type('zzqxv');
    const empty = document.getElementById('catalog-empty')!;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain('No layers match "zzqxv"');
    const clear = empty.querySelector<HTMLButtonElement>('[data-clear-search]')!;
    expect(clear.textContent).toBe('clear the search');
    clear.click();
    expect((document.getElementById('catalog-search') as HTMLInputElement).value).toBe('');
    expect(empty.hidden).toBe(true);
    expect(rows()).toEqual([true, true, true]);
  });
});
