import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs import resolves at test time, no type defs
import { TOKENS, FOOTER, NAV_LINKS, renderNav } from '../scripts/shared-chrome.mjs';

describe('TOKENS', () => {
  it('defines the published type scale', () => {
    expect(TOKENS).toContain('--fs-xs: 12px');
    expect(TOKENS).toContain('--fs-base: 15px');
    expect(TOKENS).toContain('--fs-display: 72px');
  });

  it('takes its colours from the brand module (navy links, saffron buttons)', () => {
    // Contrast is proven in contrast.test.ts and brand.test.ts.
    expect(TOKENS).toContain('--accent: #1A2A6C');
    expect(TOKENS).toContain('--accent-fill: #F28C28');
    expect(TOKENS).toContain('--accent: #F5A04A'); // dark-mode variant
  });

  it('declares dark-mode surface tokens that match mdshare bg/fg', () => {
    expect(TOKENS).toContain('--bg: #0a0a0a');
    expect(TOKENS).toContain('--fg: #ededed');
  });

  it('emits a keyboard-only focus ring (WCAG 2.4.7)', () => {
    expect(TOKENS).toMatch(/:focus-visible[\s\S]*outline:.*var\(--accent-strong\)/);
  });

  it('draws the header as a full-width bar aligned to the page column (--page-max)', () => {
    expect(TOKENS).toMatch(/\.site-header \{[^}]*margin-inline: calc\(50% - 50vw\)/);
    expect(TOKENS).toContain('--page-max');
  });

  it('defines shared .site-header / .site-nav / .site-footer classes', () => {
    expect(TOKENS).toContain('.site-header');
    expect(TOKENS).toContain('.site-nav');
    expect(TOKENS).toContain('.site-footer');
    expect(TOKENS).toContain('.site-brand .brand-mark');
  });
});

describe('renderNav', () => {
  it('emits the logo mark and the whole-word bharatlas wordmark', () => {
    const html = renderNav('catalog');
    expect(html).toContain('<a class="site-brand"');
    expect(html).toContain('class="brand-mark"');
    expect(html).toContain('<span class="brand-name">bharatlas</span>');
    expect(html).toContain('India&#39;s open atlas');
  });

  it('marks the active link with data-active', () => {
    const html = renderNav('preview');
    expect(html).toMatch(/href="\/preview"[^>]*\bdata-active\b/);
    expect(html).not.toMatch(/href="\/about"[^>]*\bdata-active\b/);
  });

  it('renders every link in NAV_LINKS', () => {
    const html = renderNav('catalog');
    for (const l of NAV_LINKS) {
      expect(html).toContain(`href="${l.href}"`);
      expect(html).toContain(`>${l.label}</a>`);
    }
  });

  it('does not include github in nav (moved to footer)', () => {
    const html = renderNav('catalog');
    expect(html).not.toContain('github.com');
  });

  it('keeps internal links target-less', () => {
    const html = renderNav('catalog');
    expect(html).toMatch(/href="\/docs"[^>]*>API &amp; MCP<\/a>/);
    expect(html).not.toMatch(/href="\/preview"[^>]*target="_blank"/);
  });

  it('follows the mockup: Layers, Collect, API & MCP, About, then an "Add a map" button', () => {
    const html = renderNav('layers');
    expect(NAV_LINKS.map((l: { label: string }) => l.label)).toEqual(['Layers', 'Collect', 'API &amp; MCP', 'About']);
    expect(html).toMatch(/<a class="nav-cta" href="\/preview"[^>]*>Add a map<\/a>/);
    expect(html).toMatch(/href="\/layers"[^>]*\bdata-active\b[^>]*>Layers</);
  });

  it('marks API & MCP active on both the docs and the MCP page', () => {
    expect(renderNav('mcp')).toMatch(/href="\/docs"[^>]*\bdata-active\b/);
    expect(renderNav('docs')).toMatch(/href="\/docs"[^>]*\bdata-active\b/);
  });

  it('marks Add a map active on the contribute page', () => {
    expect(renderNav('preview')).toMatch(/class="nav-cta" href="\/preview" data-active/);
  });

  it('can leave out the install-button script (edge-rendered pages have no /src)', () => {
    expect(renderNav('community')).toContain('/src/install.ts');
    expect(renderNav('community', { installScript: false })).not.toContain('/src/install.ts');
  });

  it('emits a unique active marker even when no key matches', () => {
    const html = renderNav('nonexistent');
    expect(html).not.toContain('data-active');
  });
});

describe('FOOTER', () => {
  it('credits urbanmorph + links code repo + pdgi', () => {
    expect(FOOTER).toContain('urbanmorph');
    expect(FOOTER).toContain('github.com/urbanmorph/geodata');
    expect(FOOTER).toContain('pdgi.org');
  });

  it('links the public status page, so it can be found from every page', () => {
    expect(FOOTER).toContain('<a href="https://status.bharatlas.com/">status</a>');
  });

  it('mentions the open-licences policy', () => {
    expect(FOOTER).toMatch(/Open licences only/i);
  });
});
