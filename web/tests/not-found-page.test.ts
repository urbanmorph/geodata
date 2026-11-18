// One 404 page for every edge route and every unmatched static path: the site's
// own chrome (header, logo, footer, tokens), noindex, a search box and the way
// back. Built once (dist/404.html); the edge functions fill in what was missing.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notFoundHtml, fillNotFound, suggestLayers, notFoundResponse, __resetNotFoundForTest } from '../functions/lib/not-found';
// @ts-expect-error: plain .mjs
import { renderNotFoundPage } from '../scripts/not-found-page.mjs';

const SHELL: string = renderNotFoundPage();
const visible = (html: string) =>
  html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');

describe('the built 404 page (dist/404.html)', () => {
  it('wears the site chrome: header with the logo, nav, footer, tokens for light and dark', () => {
    expect(SHELL).toContain('class="site-header"');
    expect(SHELL).toContain('class="brand-mark"');
    expect(SHELL).toContain('class="site-footer"');
    expect(SHELL).toContain('--fs-base');
    expect(SHELL).toContain('prefers-color-scheme: dark');
    expect(SHELL).not.toContain('/src/install.ts'); // served as-is, no Vite entry
  });

  it('is noindex and names the site', () => {
    expect(SHELL).toContain('<meta name="robots" content="noindex" />');
    expect(SHELL).toContain('<title>Page not found · bharatlas</title>');
  });

  it('says what happened by default, so a static miss reads right unfilled', () => {
    expect(visible(SHELL)).toMatch(/Page not found/);
    expect(visible(SHELL)).toMatch(/no page at this address/);
  });

  it('offers a search that works without JS, and the ways back', () => {
    expect(SHELL).toMatch(/<form[^>]*action="\/layers"[^>]*method="get"/);
    expect(SHELL).toMatch(/<input[^>]*name="q"/);
    for (const href of ['/layers', '/', '/docs']) expect(SHELL).toContain(`href="${href}"`);
    expect(visible(SHELL)).toMatch(/Find my ward/);
    expect(visible(SHELL)).toMatch(/All layers/);
  });

  it('keeps the site words: no "catalog", no em-dash', () => {
    expect(visible(SHELL)).not.toMatch(/catalog/i);
    expect(visible(SHELL)).not.toContain('—');
  });
});

describe('fillNotFound', () => {
  it('replaces the heading, message and extra, escaping the text', () => {
    const html = fillNotFound(SHELL, { title: 'Layer not found', message: 'No layer called <x>.', extra: '<p>more</p>' });
    expect(html).toContain('Layer not found');
    expect(html).toContain('No layer called &lt;x&gt;.');
    expect(html).toContain('<p>more</p>');
    expect(html).not.toMatch(/no page at this address/);
    expect(html).not.toMatch(/NF_(TITLE|MESSAGE|EXTRA)/);
  });
});

describe('suggestLayers (Did you mean)', () => {
  const layers = ['lgd_states', 'lgd_districts', 'soi_districts', 'bhuvan_districts', 'lgd_subdistricts', 'wards_pune', 'wards_chennai', 'lgd_villages']
    .map((id) => ({ id }));

  it('puts the closest id first', () => {
    expect(suggestLayers('lgd_district', layers)[0]).toBe('lgd_districts');
    expect(suggestLayers('wards_pun', layers)[0]).toBe('wards_pune');
    expect(suggestLayers('LGD_STATE', layers)[0]).toBe('lgd_states');
  });

  it('offers at most 3', () => {
    expect(suggestLayers('districts', layers).length).toBeLessThanOrEqual(3);
    expect(suggestLayers('districts', layers)).toContain('lgd_districts');
  });

  it('a prefix finds its layers', () => {
    expect(suggestLayers('wards', layers)).toEqual(expect.arrayContaining(['wards_pune', 'wards_chennai']));
  });

  it('nothing close, nothing offered', () => {
    expect(suggestLayers('qqqqzzzz', layers)).toEqual([]);
  });
});

describe('notFoundResponse', () => {
  const ctx = (assets: { fetch: (u: string) => Promise<Response> }) =>
    ({ request: new Request('https://bharatlas.com/nope'), env: { ASSETS: assets } });

  beforeEach(() => __resetNotFoundForTest());

  it('serves the themed page, filled, as a 404 with noindex and the security headers', async () => {
    const fetch = vi.fn(async () => new Response(SHELL, { status: 404 }));
    const r = await notFoundResponse(ctx({ fetch }), { title: 'Submission not found', message: 'Gone.' });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('content-security-policy')).toBeTruthy();
    const html = await r.text();
    expect(html).toContain('class="site-header"');
    expect(html).toContain('Submission not found');
    expect(html).toContain('noindex');
    // The shell is read once per isolate.
    await notFoundResponse(ctx({ fetch }), { title: 'x', message: 'y' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes extra headers (edge caching) through', async () => {
    const r = await notFoundResponse(ctx({ fetch: async () => new Response(SHELL) }), { title: 't', message: 'm' }, { 'cache-control': 'public, max-age=60' });
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('falls back to the inline page when the built page cannot be read', async () => {
    for (const fetch of [async () => { throw new Error('down'); }, async () => new Response('<html>home</html>')]) {
      __resetNotFoundForTest();
      const r = await notFoundResponse(ctx({ fetch }), { title: 'Layer not found', message: 'No such layer.' });
      expect(r.status).toBe(404);
      const html = await r.text();
      expect(html).toContain('Layer not found');
      expect(html).toContain('noindex');
      expect(html).toContain('href="/layers"');
    }
  });
});

describe('notFoundHtml (the inline fallback)', () => {
  const html = notFoundHtml('Layer not found', "There's no layer with this id.");

  it('names the site and says what was not found', () => {
    expect(html).toContain('<title>Page not found · bharatlas</title>');
    expect(html).toContain('<h1>Layer not found</h1>');
    expect(html).toContain('There&#39;s no layer');
    expect(html).not.toContain('geodata');
    expect(visible(html)).not.toMatch(/catalog/i);
  });

  it('is noindex, links to the layers and home, and uses the brand colours in both themes', () => {
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('href="/layers"');
    expect(html).toContain('href="/"');
    expect(html).toContain('#1A2A6C');
    expect(html).toContain('prefers-color-scheme:dark');
  });
});
