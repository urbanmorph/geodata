// /design: the living style guide, generated at build from shared/tokens.mjs,
// so the values it shows are the values the sites use.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  COLOR_ROLES, COLORS, FONT_SIZE, FONT_WEIGHT, SPACE, RADIUS, SHADOW, Z, MOTION, BREAKPOINTS, ICON,
  DESIGN_VERSION, DESIGN_CHANGELOG, contrast,
} from '../../shared/tokens.mjs';
import { NC_LABEL } from '../../shared/licences.mjs';
import { CHOROPLETH_RAMP } from '../../shared/choropleth.mjs';
import { footerLinksHtml } from '../../shared/footer.mjs';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
const page = read('design.html');
const visible = page
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ');

describe('/design is a first-class page', () => {
  it('is in the footer (not the main nav), the sitemap, the cache headers, the cache purge and the build', () => {
    expect(footerLinksHtml()).toContain('href="/design"');
    expect(page).not.toMatch(/<nav class="site-nav"[\s\S]*href="\/design"[\s\S]*<\/nav>/);
    expect(read('public/sitemap.xml')).toContain('<loc>https://bharatlas.com/design</loc>');
    expect(read('public/_headers')).toMatch(/^\/design\n\s+Cache-Control:/m);
    expect(read('scripts/purge-cache.mjs')).toContain("'/design'");
    expect(read('vite.config.ts')).toContain("design: resolve(__dirname, 'design.html')");
  });
  it('is a content page on the sheet, titled Design, indexable', () => {
    expect(page).toMatch(/<body class="page"/);
    expect(page).toMatch(/<main id="main" class="[^"]*\bsheet\b/);
    expect(page).toMatch(/<h1 class="page-title">Design<\/h1>/);
    expect(page).toContain('<link rel="canonical" href="https://bharatlas.com/design"');
    expect(page).not.toMatch(/<meta name="robots" content="noindex/);
  });
  it('stays lean: under 20 KB gzipped, no images but inline SVG', () => {
    expect(gzipSync(page).length).toBeLessThan(20 * 1024);
    expect(page).not.toMatch(/<img\b/);
  });
  it('has no duplicate ids', () => {
    const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});

describe('/design shows the real tokens', () => {
  it('every colour role, with its light and dark value and contrast ratio', () => {
    for (const r of COLOR_ROLES) {
      expect(page, r.name).toContain(`<code>${r.name}</code>`);
      expect(page, `${r.name} light`).toContain(r.light);
      expect(page, `${r.name} dark`).toContain(r.dark);
    }
    const fgOnBg = contrast(COLORS.light['--fg'], COLORS.light['--bg']).toFixed(1);
    expect(visible).toContain(`${fgOnBg}:1`);
  });
  it('the type scale, weights, spacing, radii, shadows, layers, motion, breakpoints and icon sizes', () => {
    for (const set of [FONT_SIZE, FONT_WEIGHT, SPACE, RADIUS, SHADOW, Z, MOTION, ICON]) {
      for (const [k, v] of Object.entries(set)) {
        expect(page, k).toContain(`<code>${k}</code>`);
        expect(visible, `${k} value`).toContain(v as string);
      }
    }
    for (const px of Object.values(BREAKPOINTS)) expect(visible).toContain(`${px} px`);
  });
  it('the data ramp and the no-data hatch', () => {
    for (const c of CHOROPLETH_RAMP) expect(page).toContain(c);
    expect(visible).toMatch(/[Nn]o data/);
  });
  it('the design version and its changelog', () => {
    expect(visible).toContain(DESIGN_VERSION);
    for (const c of DESIGN_CHANGELOG[0].changes) expect(page).toContain(c.slice(0, 30).replace(/'/g, '&#39;'));
  });
});

describe('/design shows the components and the rules', () => {
  it('live buttons: primary, secondary, toolbar, each with its states', () => {
    expect(page).toMatch(/class="btn btn--fill"/);
    expect(page).toMatch(/class="btn btn--line"/);
    expect(page).toMatch(/class="tbtn/);
    expect(page).toMatch(/class="btn btn--fill" disabled/);
    for (const s of ['Hover', 'Focus', 'Pressed', 'Disabled']) expect(visible, s).toContain(s);
  });
  it('chips, badges (with the non-commercial label), a search field and inputs', () => {
    expect(page).toMatch(/class="chip/);
    expect(page).toContain('lic-badge--nc');
    expect(visible).toContain(NC_LABEL);
    expect(page).toMatch(/type="search"/);
    expect(page).toMatch(/aria-invalid="true"/);
  });
  it('the rules in words', () => {
    for (const s of ['One primary action', '44 px', 'focus', 'reduced motion', 'forced colours', 'en-IN', 'sentence case', 'em-dash', 'layer', 'theme']) {
      expect(visible.toLowerCase(), s).toContain(s.toLowerCase());
    }
  });
  it('the logo lockup', () => {
    expect(page).toMatch(/class="site-brand"[\s\S]*class="brand-mark"/);
  });
  it('reads as the site does: no em-dash, no visible "catalog"', () => {
    expect(visible).not.toContain('—');
    expect(visible).not.toMatch(/\bcatalogu?e?\b/i);
  });
});
