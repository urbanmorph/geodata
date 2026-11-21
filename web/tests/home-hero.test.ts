// @vitest-environment happy-dom
// The home hero below the search bar: a row of separate actions ("Find my
// ward", "Open a file"), and one line of quick searches drawn at random from a
// larger pool (owner feedback, 2026-11-21). Reads the prerendered index.html
// (npm test runs prerender first).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { shuffle, firstLineCount, fitQuickSearch, wireOpenFile } from '../src/home-hero';
import { wireFindMyWard } from '../src/find-my-ward';
import { parseWardQuery, wardAnswer, wardCities } from '../src/ward-answer';
import { filterCards } from '../src/catalog-filter';

const web = resolve(__dirname, '..');
const html = readFileSync(resolve(web, 'index.html'), 'utf8');
const preview = readFileSync(resolve(web, 'preview.html'), 'utf8');
const nav = html.match(/<nav class="quick-search"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
const pills = [...nav.matchAll(/<a href="\/\?q=([^"]+)" data-q="([^"]+)">([^<]+)<\/a>/g)]
  .map((m) => ({ href: decodeURIComponent(m[1].replace(/\+/g, ' ')), q: m[2], label: m[3] }));

describe('quick-search pool', () => {
  it('renders a pool larger than one line, with no repeats', () => {
    expect(pills.length).toBeGreaterThanOrEqual(16);
    expect(new Set(pills.map((p) => p.q)).size).toBe(pills.length);
    for (const p of pills) expect(p.href).toBe(p.q);
  });

  it('keeps the old first line first, for pages without JavaScript', () => {
    expect(pills.slice(0, 3).map((p) => p.label)).toEqual(['Ward 9, Ahmedabad', 'Bengaluru wards', 'Pincodes']);
  });

  it('every pill finds layers, and every "Ward N, City" pill names its ward', () => {
    const index = JSON.parse(readFileSync(resolve(web, 'public', 'layer-index.json'), 'utf8')) as { p: string; b: string }[];
    const cards = index.map((e) => ({ primary: e.p, body: e.b }));
    for (const p of pills) {
      expect(filterCards(cards, p.q).totalMatches, p.q).toBeGreaterThan(0);
      if (!/^Ward \d/.test(p.label)) continue;
      const wq = parseWardQuery(p.q, wardCities());
      expect(wq, p.q).not.toBeNull();
      const file = resolve(web, 'public', 'ward-index', `${wq!.layerId}.json`);
      expect(existsSync(file), file).toBe(true);
      expect(wardAnswer(JSON.parse(readFileSync(file, 'utf8')), wq!.number)?.name, p.q).toBeTruthy();
    }
  });
});

describe('shuffle', () => {
  it('reorders in place and keeps every item', () => {
    const a = [1, 2, 3, 4, 5];
    const seq = [0.1, 0.9, 0.5, 0.3];
    shuffle(a, () => seq.shift() ?? 0);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(a).not.toEqual([1, 2, 3, 4, 5]);
  });
});

describe('firstLineCount', () => {
  it('counts the leading items that share the first line', () => {
    expect(firstLineCount([4, 4, 4, 68, 68])).toBe(3);
    expect(firstLineCount([4, 4, 4])).toBe(3);
    expect(firstLineCount([4, 4.4, 68])).toBe(2); // sub-pixel offsets are one line
    expect(firstLineCount([])).toBe(0);
  });
});

describe('fitQuickSearch', () => {
  it('shuffles the pills, keeps the label first, and takes wrapped pills out of the tab order', () => {
    document.body.innerHTML = '<nav class="quick-search"><span>Try:</span><a data-q="a">A</a><a data-q="b">B</a><a data-q="c">C</a><a data-q="d">D</a></nav>';
    const navEl = document.querySelector('nav')!;
    // Fake layout (happy-dom has none): whichever two pills come first sit on line one.
    const inDom = () => [...navEl.querySelectorAll('a')];
    for (const a of inDom()) Object.defineProperty(a, 'offsetTop', { get: () => (inDom().indexOf(a) < 2 ? 4 : 60) });
    let r = 0;
    fitQuickSearch(navEl, () => [0.99, 0, 0.5][r++ % 3]);
    const order = inDom();
    expect(order.map((a) => a.dataset.q).join('')).not.toBe('abcd');
    expect(navEl.firstElementChild!.tagName).toBe('SPAN');
    expect(order.map((a) => a.hasAttribute('inert'))).toEqual([false, false, true, true]);
    expect(navEl.hasAttribute('data-ready')).toBe(true);
  });
});

describe('hero actions', () => {
  const bar = html.match(/<div class="search-bar"[\s\S]*?<\/div>/)?.[0] || '';
  const actions = html.match(/<div class="hero-actions"[\s\S]*?<\/div>/)?.[0] || '';

  it('the search bar holds only the search: no paperclip, no buttons', () => {
    expect(bar).toContain('id="catalog-search"');
    expect(html).not.toContain('search-attach');
    expect(bar).not.toMatch(/<a |<button/);
  });

  it('Find my ward and Open a file are labelled actions in their own row', () => {
    expect(actions).toMatch(/<button[^>]*id="find-my-ward"[^>]*>[\s\S]*?Find my ward<\/button>/);
    const open = actions.match(/<a[^>]*id="open-file"[^>]*>[\s\S]*?<\/a>/)?.[0] || '';
    expect(open).toContain('href="/preview"'); // without JS: the picker on /preview
    expect(open).toMatch(/Open a file<\/a>$/);
    // Tab order: search, find my ward, open a file, then the quick searches.
    const at = (s: string) => html.indexOf(s);
    expect(at('id="catalog-search"')).toBeLessThan(at('id="find-my-ward"'));
    expect(at('id="find-my-ward"')).toBeLessThan(at('id="open-file"'));
    expect(at('id="open-file"')).toBeLessThan(at('<nav class="quick-search"'));
  });

  it('they, and the other calls to action, use the shared buttons (.btn), not bespoke ones', () => {
    expect(actions).toMatch(/<button type="button" class="btn btn--fill" id="find-my-ward"/);
    expect(actions).toMatch(/<a class="btn btn--line" id="open-file"/);
    expect(html).toMatch(/<a class="btn btn--fill" href="\/mcp">Connect via MCP<\/a><a class="btn btn--line" href="\/docs">/);
    expect(readFileSync(resolve(web, 'src', 'ward-answer.ts'), 'utf8')).toContain('class="btn btn--fill ward-answer__go"');
    const layers = readFileSync(resolve(web, 'layers.html'), 'utf8');
    const views = [...layers.matchAll(/<a [^>]*class="([^"]*btn-primary[^"]*)"/g)].map((m) => m[1]);
    expect(views.length).toBeGreaterThan(10);
    for (const c of views) expect(c).toMatch(/^btn btn--line btn-primary/);
  });

  it('says a file can be dropped anywhere, and which formats, as /preview does', () => {
    expect(html).toMatch(/drop a file anywhere on this page/);
    const accept = (page: string) => page.match(/<input type="file"[^>]*accept="([^"]+)"/)?.[1];
    expect(accept(html)).toBeTruthy();
    expect(accept(html)).toBe(accept(preview));
    expect(html).toMatch(/GeoJSON, KML, KMZ, GPX, TCX or Parquet/);
  });
});

describe('wireOpenFile', () => {
  it('opens the picker from the click, and hands the picked file on', () => {
    document.body.innerHTML = '<a id="l" href="/preview">Open a file</a><input type="file" id="i" hidden>';
    const link = document.getElementById('l') as HTMLAnchorElement;
    const input = document.getElementById('i') as HTMLInputElement;
    const pick = vi.spyOn(input, 'click').mockImplementation(() => {});
    const open = vi.fn();
    wireOpenFile(link, input, open);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(pick).toHaveBeenCalledTimes(1);
    const file = new File(['{}'], 'a.geojson');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    expect(open).toHaveBeenCalledWith(file);
  });
});

describe('wireFindMyWard', () => {
  it('asks for the location synchronously inside the click (iOS drops it after an await)', () => {
    document.body.innerHTML = '<button id="b">Find my ward</button><p id="s" hidden></p>';
    const getCurrentPosition = vi.fn();
    wireFindMyWard(document.getElementById('b')!, document.getElementById('s')!, {
      geolocation: { getCurrentPosition }, fetch: vi.fn(), go: vi.fn(),
    });
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click'));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1); // no await between the click and this line
  });

  it('says so when the browser has no geolocation', () => {
    document.body.innerHTML = '<button id="b">Find my ward</button><p id="s" hidden></p>';
    const status = document.getElementById('s')!;
    wireFindMyWard(document.getElementById('b')!, status, { geolocation: undefined, fetch: vi.fn(), go: vi.fn() });
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click'));
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/can't share your location/);
  });
});
