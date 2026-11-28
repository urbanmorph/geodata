// @vitest-environment happy-dom
// The home line "N layers · X downloads · Y API queries · updated …": the live
// refresh replaces the download total only, and the search's match line never
// replaces the idle line (it hides it), so live counts survive a search.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { refreshLiveCounts } from '../src/live-counts';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');

afterEach(() => vi.unstubAllGlobals());

describe('live download total on the home line', () => {
  it('replaces the download total and keeps the API queries', async () => {
    document.body.innerHTML =
      '<p id="search-meta"><span id="search-meta-idle"><span class="search-meta__layers">168 layers</span>' +
      '<span id="dl-total"> · <span class="search-meta__count">39k</span> downloads</span>' +
      '<span id="api-total"> · <span class="search-meta__count">1.5k</span> API queries</span></span></p>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ _total: 123456 }))));
    refreshLiveCounts();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const text = document.getElementById('search-meta')!.textContent!;
    expect(document.getElementById('dl-total')!.textContent).toMatch(/123k|1\.2L|123,456|123\.5k/);
    expect(text).toContain('1.5k API queries');
  });

  it('the prerendered API suffix sits in its own slot, outside #dl-total', () => {
    expect(read('index.template.html')).toMatch(/<span id="dl-total"><!-- DOWNLOAD_TOTAL --><\/span><span id="api-total"><!-- API_TOTAL --><\/span>/);
  });
});

describe('per-format counts on /layers rows', () => {
  it("patches a row's own links, not its compare-sources links (those are other layers)", async () => {
    vi.resetModules();
    const { patchDownloadCounts } = await import('../src/live-counts');
    document.body.innerHTML =
      '<section class="row" data-id="a"><p class="row__downloads"><span class="dl-inline"><a href="/x" download data-fmt="parquet">parquet</a><span class="size">1 KB</span></span></p>' +
      '<details class="alt"><span class="links"><a href="/y" download data-fmt="parquet">parquet</a><span class="dot">·</span><a href="/z" download data-fmt="kml">kml</a></span></details></section>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ a: { parquet: 7, kml: 3 } }))));
    await patchDownloadCounts(document.querySelector<HTMLElement>('.row')!);
    expect(document.querySelector('.row__downloads .count')!.textContent).toBe('7');
    expect(document.querySelector('.alt .count')).toBeNull();
  });
});

describe('the search match line', () => {
  it('has its own slot; the idle line is hidden, never swapped out and restored', () => {
    expect(read('index.template.html')).toMatch(/<span id="search-meta-idle">[\s\S]*<\/span><span id="search-meta-match" hidden><\/span><\/p>/);
    const main = read('src/main.ts');
    expect(main).not.toMatch(/idleMeta/);
    expect(main).toMatch(/searchMatch\.innerHTML = matchSummaryHtml\(/);
  });
});
