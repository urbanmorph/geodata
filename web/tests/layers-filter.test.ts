// @vitest-environment happy-dom
// /layers filters its rows from /layer-index.json (the rows no longer carry
// their search text). Until the index arrives every row stays visible, which
// is also the no-JS page; a ?q= arrival filters as soon as it lands.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/live-counts', () => ({ refreshLiveCounts: () => {}, patchDownloadCounts: async () => {} }));
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

  it('hides the requested layers at the top while a search is active', async () => {
    document.body.insertAdjacentHTML('afterbegin', '<section id="requested"></section>');
    history.replaceState(null, '', '/layers');
    await import('../src/layers');
    release();
    const input = document.getElementById('catalog-search') as HTMLInputElement;
    const strip = document.getElementById('requested')!;
    input.value = 'forest';
    input.dispatchEvent(new Event('input'));
    await flush(); await flush();
    expect(strip.hidden).toBe(true);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(strip.hidden).toBe(false);
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
    expect(empty.querySelector('a[href="/docs?q=zzqxv#request"]')?.textContent).toBe('Request this layer');
    const clear = empty.querySelector<HTMLButtonElement>('[data-clear-search]')!;
    expect(clear.textContent).toBe('clear the search');
    clear.click();
    expect((document.getElementById('catalog-search') as HTMLInputElement).value).toBe('');
    expect(empty.hidden).toBe(true);
    expect(rows()).toEqual([true, true, true]);
  });
});

// Themes sit under realms (below ground, on the ground, in the air): a search
// hides a realm with no match and counts each realm's matching layers.
describe('/layers filter: realms', () => {
  const type = async (q: string) => {
    const input = document.getElementById('catalog-search') as HTMLInputElement;
    input.value = q;
    input.dispatchEvent(new Event('input'));
    await flush(); await flush();
  };
  const realm = (id: string) => document.getElementById(id)!;
  const indexLink = (id: string) => document.querySelector<HTMLElement>(`.theme-index a[href="#${id}"]`)!;
  const n = (id: string) => indexLink(id).querySelector('.theme-index__n')!.textContent;

  beforeEach(() => {
    document.body.innerHTML = `
      <input id="catalog-search"><p id="search-meta"></p><p id="catalog-empty" hidden></p>
      <nav class="theme-index">
        <a class="theme-index__realm" href="#below"><span>Below ground</span><span class="theme-index__n">1</span></a>
        <a href="#below-environment"><span>Environment</span><span class="theme-index__n">1</span></a>
        <a class="theme-index__realm" href="#ground"><span>On the ground</span><span class="theme-index__n">5</span></a>
        <a href="#ground-boundaries"><span>Boundaries</span><span class="theme-index__n">4</span></a>
        <a href="#ground-water"><span>Water</span><span class="theme-index__n">1</span></a>
      </nav>
      <div id="catalog-grid">
        <section class="realm" id="below"><header class="realm__head"><h2>Below ground</h2></header>
          <section class="category-section" id="below-environment"><section class="row" data-id="forest_cover" data-layers="1"></section></section>
        </section>
        <section class="realm" id="ground"><header class="realm__head"><h2>On the ground</h2></header>
          <section class="category-section" id="ground-boundaries"><section class="row" data-id="lgd_districts" data-layers="4"></section></section>
          <section class="category-section" id="ground-water"><article class="comm-card" data-id="abcdefgh"></article></section>
        </section>
      </div>`;
    history.replaceState(null, '', '/layers');
  });

  it('hides a realm with no match, counts matches per realm, and restores both when cleared', async () => {
    await import('../src/layers');
    release();
    await type('forest');
    expect(realm('below').hidden).toBe(false);
    expect(realm('ground').hidden).toBe(true);
    expect(n('below')).toBe('1');
    expect(n('ground')).toBe('0');
    expect(indexLink('ground').classList.contains('is-empty')).toBe(true);
    await type('lakes');
    expect(realm('below').hidden).toBe(true);
    expect(realm('ground').hidden).toBe(false);
    expect(n('ground')).toBe('1');
    await type('');
    expect(realm('below').hidden).toBe(false);
    expect(realm('ground').hidden).toBe(false);
    expect(n('ground')).toBe('5');
    expect(document.querySelector('.theme-index a.is-empty')).toBeNull();
  });
});

// The desktop index lists every realm but opens only the one in view (CSS
// keys off .is-active while the nav has .is-following); a search opens all.
describe('/layers index: follows the realm in view', () => {
  let seen: (entries: { target: Element; isIntersecting: boolean }[]) => void = () => {};
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="catalog-search"><p id="search-meta"></p><p id="catalog-empty" hidden></p>
      <nav class="theme-index">
        <div class="theme-index__group"><a class="theme-index__realm" href="#below">Below</a><a href="#below-environment">Env</a></div>
        <div class="theme-index__group"><a class="theme-index__realm" href="#ground">Ground</a><a href="#ground-boundaries">Bound</a></div>
      </nav>
      <div id="catalog-grid">
        <section class="realm" id="below"><section class="category-section" id="below-environment"><section class="row" data-id="forest_cover" data-layers="1"></section></section></section>
        <section class="realm" id="ground"><section class="category-section" id="ground-boundaries"><section class="row" data-id="lgd_districts" data-layers="4"></section></section></section>
      </div>`;
    history.replaceState(null, '', '/layers');
    vi.stubGlobal('IntersectionObserver', class { constructor(cb: typeof seen) { seen = cb; } observe() {} });
  });
  const active = () => [...document.querySelectorAll('.theme-index__group.is-active a.theme-index__realm')].map((a) => a.getAttribute('href'));
  const following = () => document.querySelector('.theme-index')!.classList.contains('is-following');

  it('opens the realm in view, a focused realm, and every realm while searching', async () => {
    await import('../src/layers');
    release();
    expect(following()).toBe(true);
    expect(active()).toEqual(['#below']);
    seen([{ target: document.getElementById('ground')!, isIntersecting: true }]);
    expect(active()).toEqual(['#ground']);
    document.querySelector<HTMLElement>('a[href="#below"]')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(active()).toEqual(['#below']);
    const input = document.getElementById('catalog-search') as HTMLInputElement;
    input.value = 'forest';
    input.dispatchEvent(new Event('input'));
    await flush(); await flush();
    expect(following()).toBe(false);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(following()).toBe(true);
  });

  it('leaves every realm open without IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    await import('../src/layers');
    expect(following()).toBe(false);
  });
});
