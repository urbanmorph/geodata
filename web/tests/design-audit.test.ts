// The design-language audit (Nov 2026), as checks so the fixes stay fixed:
// the brand on every screen, one header, 44 px targets, sentence-case labels,
// plain button text. Reads the built pages (npm test prerenders first) and sources.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderViewPage } from '../functions/lib/render-view';
import { WARD_PLACES } from '../functions/lib/ward-places';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../scripts/shared-chrome.mjs';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const home = read('index.html');
const submission = {
  id: 'x', created_at: '2026-01-01', updated_at: null, status: 'accepted', name: 'Temples', description: null,
  category: 'culture', license: 'CC-BY-4.0', attribution: 'x', source_url: 'https://x', is_original: 1,
  data_year: 2026, format: 'kml', bytes: 10, feature_count: 1, geometry_types: 'Point', r2_key: 'community/x/x.kml',
};
const community = renderViewPage({ submission: submission as never, ratingsCount: 0 });

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
    expect(read('layers.template.html')).toMatch(/\.btn-primary \{[^}]*min-height: 44px/);
    expect(read('layers.template.html')).toMatch(/\.dl-inline a \{[^}]*min-height: 44px/);
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

// ── Design audit 2026-11-18 (fix 1): high-impact items and quick wins ──
const tmplHome = read('index.template.html');
const tmplLayers = read('layers.template.html');
const coarse = (css: string) => [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\s*\}\n/g)].map((m) => m[1]).join('\n');

describe('H3. an active filter shows when the Filter panel is closed', () => {
  const map = read('src/map.ts');
  const filter = read('src/filter.ts');
  it('the Filter button carries a count badge', () => {
    expect(map).toContain('btn.dataset.filterCount = ');
    expect(tmplHome).toMatch(/\[data-filter-count\][^{]*::after \{[^}]*content: attr\(data-filter-count\)/);
  });
  it('a "Filtered: ..." pill over the map clears the filter', () => {
    expect(map).toContain('filter-pill');
    expect(map).toMatch(/Filtered: /);
    expect(map).toMatch(/aria-label="Clear filter"/);
    expect(tmplHome).toMatch(/\.filter-pill \{/);
  });
  it('closing the panel keeps the filter (only the pill or the chips clear it)', () => {
    expect(filter).not.toMatch(/closeBtn\.addEventListener\('click', \(\) => \{\s*callbacks\.onActiveFiltersChange\?\.\(\[\], null\)/);
  });
  it('the match count and the export buttons stay in view while picking', () => {
    expect(filter).toMatch(/<div class="filter-panel__foot">\s*<div class="filter-panel__row" id="filter-summary">/);
    expect(tmplHome).toMatch(/\.filter-panel__foot \{[^}]*position: sticky;[^}]*bottom: /);
    expect(filter).not.toMatch(/rows match/);
  });
});

describe('H4. map tap targets are 44 px on touch screens', () => {
  const touch = coarse(tmplHome);
  it('filter chips keep their look and get a 44 px hit area', () => {
    expect(touch).toMatch(/\.filter-chip::before \{[^}]*inset: -9px/);
  });
  it('MapLibre zoom and compass buttons are 44 px; the attribution (i) gets a hit area', () => {
    expect(touch).toMatch(/\.maplibregl-ctrl-group button \{[^}]*width: 44px; height: 44px/);
    expect(touch).toMatch(/\.maplibregl-ctrl-attrib-button::before \{[^}]*inset: -10px/);
  });
  it('licence badge links and the header Install app have a 44 px hit area', () => {
    const shared = coarse(TOKENS);
    expect(shared).toMatch(/a\.lic-badge::before \{[^}]*inset: -13px 0/);
    expect(shared).toMatch(/\.install-app::before \{[^}]*inset: -7px 0/);
  });
});

describe('quick wins', () => {
  it('theme cards say "1 layer", not "1 layers"', () => {
    expect(home).not.toMatch(/class="count">1<\/span> layers/);
    // The fixture build may have no one-layer theme: check the card template too.
    expect(read('scripts/prerender.mjs')).not.toMatch(/<span class="count">\$\{n\}<\/span> layers</);
  });
  it('the search fields show a visible focus outline', () => {
    expect(tmplHome).toMatch(/\.search-bar:focus-within \{[^}]*outline: 2px solid var\(--accent-strong\)/);
    expect(tmplLayers).toMatch(/\.layers-search:focus-within \{[^}]*outline: 2px solid var\(--accent-strong\)/);
  });
  it('collect buttons use the site font', () => {
    expect(readFileSync(resolve(__dirname, '../../collect/src/styles.css'), 'utf8')).toMatch(/\nbutton, \.btn \{\s*font: inherit;/);
  });
  it('the brand stays lowercase in the base-map list', () => {
    expect(read('src/basemaps.ts')).not.toContain("'Bharatlas Minimal'");
    expect(read('src/basemaps.ts')).toContain("'bharatlas Minimal'");
  });
  it('the contribute page says what happens to a file in plain words', () => {
    const preview = read('preview.template.html');
    expect(preview).not.toMatch(/R2|D1/);
    expect(preview).toContain('Nothing leaves your device until you press Publish.');
  });
  it('the ward city count is one computed number, said the same way', () => {
    const ns = [...home.matchAll(/(?:Ward maps|Ward and zone maps) for (\S+) cities/g)].map((m) => m[1]);
    expect(ns.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ns).size).toBe(1);
    // True: every city with a ward map, its vintages and alternates counted once.
    expect(Number(ns[0])).toBe(new Set(Object.values(WARD_PLACES).map((p) => p.city)).size);
    expect(home).not.toMatch(/over \d+ cities|over villages/);
  });
  it('map links all say "View map"', () => {
    const sources = ['functions/lib/render-view.ts', 'src/ward-answer.ts', 'scripts/community-card.mjs'].map(read).join('\n');
    expect(sources).not.toMatch(/>View on map</);
    expect(read('functions/lib/render-view.ts')).toContain('>View map</a>');
    expect(read('src/ward-answer.ts')).toContain('>View map</a>');
  });
  it('/layers titles wrap to two lines so the year stays visible', () => {
    expect(tmplLayers).toMatch(/\.row__summary > \.row__title \{[^}]*-webkit-line-clamp: 2;/);
    expect(tmplLayers).not.toMatch(/\.row__summary > \.row__title \{[^}]*white-space: nowrap/);
  });
  it('/layers counts use tabular figures', () => {
    expect(tmplLayers).toMatch(/\.theme-index__n \{[^}]*tabular-nums/);
    expect(tmplLayers).toMatch(/\.category-section__count \{[^}]*tabular-nums/);
  });
});

describe('L1. layer descriptions have no em-dashes or internal notes', () => {
  const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8'));
  const layer = (id: string) => catalog.layers.find((l: { id: string }) => l.id === id);
  it('wards_bengaluru_gba', () => {
    expect(layer('wards_bengaluru_gba').notes).not.toContain('—');
    expect(catalog.level_meta.wards_bengaluru_gba.description).not.toContain('—');
    expect(catalog.level_meta.wards_bengaluru_gba.description).toMatch(/^Greater Bengaluru Authority: 369 final wards/);
  });
  it('gb_adm4 has a plain public description', () => {
    expect(layer('gb_adm4').notes).toBe('Block-level boundaries from geoBoundaries (published upstream as ADM4, but they match blocks, not villages).');
  });
});
