// @vitest-environment happy-dom
// /layers loads each row's download links when the row is opened, from a small
// baked file per row (/layer-dl/<row id>.json), so the page carries about 15 KB
// gzipped less. Descriptions, source, licence and updated lines stay in the
// HTML. Without JS a row links to its map page, where the Download menu works.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { availableDownloads } from '../src/format-hints';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
const layersHtml = read('layers.html');
type Layer = { id: string; level: string; provenance?: string } & Record<string, unknown>;
const catalog = JSON.parse(read('../catalog.json')) as { layers: Layer[] };

// The curated rows: <section class="row ..." id="<level>" data-id="<primary>" data-layers="N">...</section>
const rows = [...layersHtml.matchAll(/<section class="row row--curated[^"]*" id="([^"]+)" data-id="([^"]+)" data-layers="(\d+)">([\s\S]*?)<\/section>/g)]
  .map(([, level, id, n, body]) => ({ level, id, n: Number(n), body }));

describe('/layers rows, as built', () => {
  it('carry no download links of their own (community cards keep theirs)', () => {
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) {
      expect(r.body, r.level).not.toContain('/api/dl/');
      expect(r.body, r.level).not.toContain('data-fmt=');
    }
  });

  it('link to the map page in place of the links, for a reader without JS', () => {
    const withDl = rows.filter((r) => r.body.includes('row__downloads'));
    expect(withDl.length).toBeGreaterThan(100);
    for (const r of withDl) {
      expect(r.body, r.level).toContain(`<p class="row__downloads"><a href="/view/${r.id}">Downloads on the map page</a></p>`);
    }
  });

  it('keep the description, source, licence and updated lines in the HTML', () => {
    const states = rows.find((r) => r.level === 'state')!;
    expect(states.body).toContain('class="row__desc"');
    expect(states.body).toContain('class="row__lic-line"');
    expect(layersHtml).toContain('class="row__updated"');
  });

  it('mark each "compare sources" layer for its links', () => {
    const multi = rows.filter((r) => r.n > 1);
    expect(multi.length).toBeGreaterThan(5);
    for (const r of multi) {
      const marks = [...r.body.matchAll(/<span class="links" data-dl="([^"]+)"><\/span>/g)].map((m) => m[1]);
      expect(marks.length, r.level).toBe(r.n);
    }
  });
});

describe('/layer-dl/<row id>.json', () => {
  it("holds every layer in the row with the map's download list, sizes and counts", () => {
    for (const r of rows.filter((x) => x.body.includes('row__downloads'))) {
      const f = `public/layer-dl/${r.level}.json`;
      expect(existsSync(resolve(__dirname, '..', f)), f).toBe(true);
      const file = JSON.parse(read(f)) as Record<string, { fmt: string; url: string; bytes: number | null; count: number }[]>;
      const layers = catalog.layers.filter((l) => l.level === r.level && l.provenance !== 'community');
      expect(Object.keys(file).sort()).toEqual(layers.map((l) => l.id).sort());
      for (const l of layers) {
        expect(file[l.id].map(({ fmt, url, bytes }) => ({ fmt, url, bytes })), l.id)
          .toEqual(availableDownloads(l as never).map((d) => ({ fmt: d.fmt, url: d.url, bytes: d.bytes })));
        for (const d of file[l.id]) expect(typeof d.count).toBe('number');
      }
    }
  });

  it('is cached briefly, gitignored and named by a plain row id', () => {
    expect(read('public/_headers')).toMatch(/^\/layer-dl\/\*\n\s+Cache-Control: public, max-age=300/m);
    expect(read('.gitignore')).toMatch(/^public\/layer-dl\/$/m);
    for (const r of rows) expect(r.level).toMatch(/^[a-z0-9_]+$/);
  });
});

const ENTRIES = [
  { fmt: 'parquet', url: '/api/dl/x/a.parquet', bytes: 3_565_158, count: 14 },
  { fmt: 'pmtiles', url: 'https://data.bharatlas.com/x/a.pmtiles', bytes: 1_258_291, count: 0 },
  { fmt: 'shapefile', url: '/api/dl/x/a.zip', bytes: 900, count: 1234 },
];

describe('the row download renderer', () => {
  it('writes the same links, sizes and counts the page used to bake', async () => {
    const { downloadsHtml } = await import('../src/layer-downloads');
    const html = downloadsHtml(ENTRIES);
    expect(html).toMatch(/^Download: <span class="dl-inline">/);
    // each format's link, size and count wrap as one unit, never split across lines
    expect(html).toContain('<span class="dl-item"><a href="/api/dl/x/a.parquet" download data-fmt="parquet">parquet</a><span class="size">3.4 MB</span><span class="count" title="14 downloads">14</span></span>');
    expect(html).toContain('<span class="dl-item"><a href="https://data.bharatlas.com/x/a.pmtiles" download data-fmt="pmtiles">pmtiles</a><span class="size">1.2 MB</span></span><span class="dl-item">');
    expect(html).toMatch(/<a href="[^"]+" download data-fmt="shapefile">shp<\/a>/);
    expect(html).toContain('title="1,234 downloads"');
  });
  it('lists a compare-sources layer with dots between its links, or says it has none', async () => {
    const { altLinksHtml } = await import('../src/layer-downloads');
    expect(altLinksHtml(ENTRIES.slice(0, 2))).toBe(
      '<a href="/api/dl/x/a.parquet" download data-fmt="parquet">parquet</a><span class="dot">·</span>' +
      '<a href="https://data.bharatlas.com/x/a.pmtiles" download data-fmt="pmtiles">pmtiles</a>',
    );
    expect(altLinksHtml([])).toBe('<span class="muted">no downloads</span>');
  });
  it('escapes what it writes', async () => {
    const { downloadsHtml } = await import('../src/layer-downloads');
    expect(downloadsHtml([{ fmt: 'geojson', url: '/a"b<c', bytes: 1, count: 0 }])).toContain('href="/a&quot;b&lt;c"');
  });
});

// One row as the page builds it, with a compare-sources list.
function page(): void {
  document.body.innerHTML = `<div id="catalog-grid"><section class="row row--curated" id="state" data-id="lgd_states" data-layers="2">
    <div class="row__head"><details class="row__details"><summary class="row__summary">States</summary><div class="row__expand">
    <p class="row__desc">x</p><p class="row__downloads"><a href="/view/lgd_states">Downloads on the map page</a></p>
    <details class="alt"><summary>compare sources</summary><div class="alt__list">
    <div class="alt__row"><span class="links" data-dl="lgd_states"></span></div>
    <div class="alt__row"><span class="links" data-dl="soi_states"></span></div></div></details>
    </div></details></div></section></div>`;
}
const FILE = { lgd_states: ENTRIES.slice(0, 1), soi_states: [] };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const open = (d: HTMLDetailsElement) => { d.open = true; d.dispatchEvent(new Event('toggle')); };

describe('opening a row', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    page();
    fetchMock = vi.fn(async (url: string) =>
      url === '/api/dl/counts'
        ? new Response(JSON.stringify({ lgd_states: { parquet: 99 } }))
        : new Response(JSON.stringify(FILE)));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const dlCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/layer-dl/'));

  it('loads its links in one fetch, fills the compare list, and a second open does not refetch', async () => {
    const { wireLazyDownloads } = await import('../src/layer-downloads');
    wireLazyDownloads(document.getElementById('catalog-grid')!);
    const details = document.querySelector<HTMLDetailsElement>('.row__details')!;
    open(details);
    await flush();
    expect(dlCalls().map(([u]) => u)).toEqual(['/layer-dl/state.json']);
    const p = document.querySelector('.row__downloads')!;
    expect(p.innerHTML).toMatch(/^Download: <span class="dl-inline"><span class="dl-item"><a href="\/api\/dl\/x\/a.parquet" download(="")? data-fmt="parquet">parquet<\/a>/);
    expect(document.querySelector('[data-dl="soi_states"]')!.innerHTML).toContain('no downloads');
    expect(document.querySelector('[data-dl="lgd_states"] a[download]')).not.toBeNull();
    details.open = false; details.dispatchEvent(new Event('toggle'));
    open(details);
    await flush();
    expect(dlCalls().length).toBe(1);
  });

  it('patches the live download counts into links it adds', async () => {
    const { wireLazyDownloads } = await import('../src/layer-downloads');
    wireLazyDownloads(document.getElementById('catalog-grid')!);
    open(document.querySelector<HTMLDetailsElement>('.row__details')!);
    await flush();
    expect(document.querySelector('.row__downloads .count')!.textContent).toBe('99');
    // The compare-sources links keep no count (counts are per row's primary layer).
    expect(document.querySelector('.alt .count')).toBeNull();
  });

  it('loads a row that is already open when the page wires up', async () => {
    document.querySelector<HTMLDetailsElement>('.row__details')!.open = true;
    const { wireLazyDownloads } = await import('../src/layer-downloads');
    wireLazyDownloads(document.getElementById('catalog-grid')!);
    await flush();
    expect(dlCalls().length).toBe(1);
  });

  it('opening only the nested compare list does nothing of its own', async () => {
    const { wireLazyDownloads } = await import('../src/layer-downloads');
    wireLazyDownloads(document.getElementById('catalog-grid')!);
    open(document.querySelector<HTMLDetailsElement>('details.alt')!);
    await flush();
    expect(dlCalls().length).toBe(0);
  });

  it('on a failure says so plainly, keeps the map-page link, and tries again on the next open', async () => {
    fetchMock.mockImplementation(async (url: string) => (url === '/api/dl/counts' ? new Response('{}') : new Response('no', { status: 503 })));
    const { wireLazyDownloads } = await import('../src/layer-downloads');
    wireLazyDownloads(document.getElementById('catalog-grid')!);
    const details = document.querySelector<HTMLDetailsElement>('.row__details')!;
    open(details);
    await flush();
    const p = document.querySelector('.row__downloads')!;
    expect(p.textContent).toMatch(/^The download links did not load\. Downloads on the map page$/);
    expect(p.querySelector('a')!.getAttribute('href')).toBe('/view/lgd_states');
    expect(p.hasAttribute('aria-busy')).toBe(false);
    details.open = false; details.dispatchEvent(new Event('toggle'));
    open(details);
    await flush();
    expect(dlCalls().length).toBe(2);
    expect(p.textContent).toMatch(/^The download links did not load\. Downloads on the map page$/);
  });
});
