// One footer for every surface: the prerendered pages, the community layer
// pages (/c/<id>), /submit and collect's home. Adding a link (status) once
// must reach all of them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { footerHtml, footerLinksHtml } from '../../shared/footer.mjs';
import { FOOTER } from '../scripts/shared-chrome.mjs';
import { renderViewPage } from '../functions/lib/render-view';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('footer links', () => {
  it('link privacy, terms, status, code and the makers', () => {
    const links = footerLinksHtml();
    for (const href of ['/privacy', '/terms', 'https://status.bharatlas.com/', 'https://github.com/urbanmorph/geodata', 'https://urbanmorph.com', 'https://pdgi.org']) {
      expect(links).toContain(`href="${href}"`);
    }
  });

  it('can use absolute URLs for other sites (collect)', () => {
    expect(footerLinksHtml({ absolute: true })).toContain('href="https://bharatlas.com/privacy"');
  });

  it('takes a page-specific note above the links, escaped', () => {
    const html = footerHtml({ note: 'Community <layers>' });
    expect(html).toContain('<p>Community &lt;layers&gt;</p>');
    expect(html).toContain(footerLinksHtml());
  });
});

describe('every surface uses the shared footer', () => {
  it('prerendered pages (shared-chrome FOOTER)', () => {
    expect(FOOTER).toBe(footerHtml());
  });

  it('community layer pages (/c/<id>)', () => {
    const submission = {
      id: 'x', created_at: '2026-01-01', updated_at: null, status: 'accepted', name: 'X', description: null,
      category: 'environment', license: 'CC0-1.0', attribution: 'x', source_url: 'https://x', is_original: 0,
      data_year: null, format: 'geojson', bytes: 10, feature_count: 1, geometry_types: 'Point', r2_key: 'community/x/x.geojson',
    };
    const html = renderViewPage({ submission: submission as never, origin: 'https://bharatlas.com', ratingsCount: 0, alreadyRated: false });
    expect(html).toContain(footerLinksHtml());
  });

  it('/submit (a standalone page, kept identical)', () => {
    expect(read('web/submit.html')).toContain(footerHtml());
  });

  it('collect home', () => {
    expect(read('collect/src/landing.ts')).toContain('footerLinksHtml({ absolute: true })');
  });
});
