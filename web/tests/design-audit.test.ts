// The design-language audit (Nov 2026), as checks so the fixes stay fixed:
// the brand on every screen, one header, 44 px targets, sentence-case labels,
// plain button text. Reads the built pages (npm test prerenders first) and sources.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderViewPage } from '../functions/lib/render-view';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../scripts/shared-chrome.mjs';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const home = read('index.html');
const submission = {
  id: 'x', created_at: '2026-01-01', updated_at: null, status: 'accepted', name: 'Temples', description: null,
  category: 'culture', license: 'CC-BY-4.0', attribution: 'x', source_url: 'https://x', is_original: 1,
  data_year: 2026, format: 'kml', bytes: 10, feature_count: 1, geometry_types: 'Point', r2_key: 'community/x/x.kml',
};
const community = renderViewPage({ submission: submission as never, origin: 'https://bharatlas.com', ratingsCount: 0, alreadyRated: false });

describe('1. the map screen keeps the brand', () => {
  it('has the logo in its toolbar, linking home', () => {
    expect(home).toMatch(/<header class="map-bar">\s*<a class="map-brand" href="\/" aria-label="bharatlas home"><svg class="brand-mark"/);
  });
});

describe('2. community pages use the site header and a main landmark', () => {
  it('shares the nav (Add a map) and wraps content in <main>', () => {
    expect(community).toContain('class="nav-cta"');
    expect(community).toMatch(/<main id="main"/);
    expect(community).not.toContain('mark-accent');
  });
});

describe('3, 5, 6, 8. labels are sentence case (no all-caps)', () => {
  for (const f of ['index.template.html', 'preview.template.html', 'docs.template.html', 'mcp.template.html', 'about.template.html', 'functions/lib/render-view.ts']) {
    it(f, () => expect(read(f)).not.toMatch(/text-transform:\s*uppercase/));
  }
});

describe('3, 5, 6. touch targets', () => {
  it('View map buttons and download links are tall enough', () => {
    expect(read('index.template.html')).toMatch(/\.btn-primary \{[^}]*min-height: 44px/);
    expect(read('index.template.html')).toMatch(/\.dl-inline a \{[^}]*min-height: 32px/);
  });
  it('docs section links and the contribute paste toggle are 44 px', () => {
    expect(read('docs.template.html')).toMatch(/min-height: 44px/);
    expect(read('preview.template.html')).toMatch(/#paste-back-toggle \{[^}]*min-height: 44px/);
  });
});

describe('4. the MCP title badge stays badge-sized', () => {
  // The shared .badge (shared-chrome TOKENS) sets its own small mono size, so
  // it stays badge-sized inside the 44px title with no page rule.
  it('uses the shared badge in the page title', () => {
    expect(read('mcp.template.html')).toMatch(/class="page-title">[^<]*<span class="badge badge--stable">/);
    expect(TOKENS).toMatch(/\.badge \{[^}]*font: 600 var\(--fs-xs\)/);
  });
});

describe('5. docs section headings match the other pages', () => {
  it('uses the shared section scale, not the old underlined 20 px', () => {
    expect(read('docs.template.html')).not.toMatch(/h2 \{ font-size: 20px/);
    expect(read('mcp.template.html')).not.toMatch(/h2 \{ font-size: 20px/);
  });
});

describe('7. collect has one primary action', () => {
  it('the Install app pill is outlined, as on bharatlas.com', () => {
    expect(readFileSync(resolve(__dirname, '../../collect/src/styles.css'), 'utf8')).toMatch(/button\.install-app \{[^}]*background: transparent;[^}]*border-color: var\(--line-strong\)/);
  });

  it('sync setup is a secondary button', () => {
    expect(readFileSync(resolve(__dirname, '../../collect/src/landing.ts'), 'utf8')).toContain('<button class="wide" id="sync-setup">');
  });
});

describe('9. the search placeholder fits a phone', () => {
  it('is short (the ward example is a quick search)', () => {
    expect(home).toContain('placeholder="Search a ward, place or map"');
  });
});

describe('10. buttons say what they do, without arrows', () => {
  const sources = ['about.template.html', 'preview.template.html', 'scripts/prerender.mjs', 'functions/lib/render-view.ts'].map(read).join('\n');
  it('no → at the end of a button or button-styled link', () => {
    expect(sources).not.toMatch(/→<\/button>/);
    expect(sources).not.toMatch(/class="[^"]*\b(btn|btn-primary|cta|primary)\b[^"]*"[^>]*>[^<]*→<\/a>/);
  });
});

describe('reading width on docs and MCP', () => {
  for (const f of ['docs.template.html', 'mcp.template.html']) {
    it(`${f}: paragraphs and lists stop at 720px; tables and code keep the page width`, () => {
      // body.page brings the 720px reading width (shared-chrome TOKENS).
      expect(read(f)).toMatch(/<body class="page"/);
      expect(TOKENS).toMatch(/\.page main :is\(p, ul, ol\) \{ max-width: 720px; \}/);
    });
  }
});
