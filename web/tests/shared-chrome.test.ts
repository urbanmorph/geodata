import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs import resolves at test time, no type defs
import { TOKENS, FOOTER, NAV_LINKS, renderNav } from '../scripts/shared-chrome.mjs';

describe('TOKENS', () => {
  it('defines the published type scale', () => {
    expect(TOKENS).toContain('--fs-xs: 11px');
    expect(TOKENS).toContain('--fs-base: 14px');
    expect(TOKENS).toContain('--fs-display: 36px');
  });

  it('uses the mdshare-aligned indigo accent in both modes', () => {
    expect(TOKENS).toContain('--accent: #6366f1');
    expect(TOKENS).toContain('--accent: #818cf8'); // dark-mode variant
  });

  it('declares dark-mode surface tokens that match mdshare bg/fg', () => {
    expect(TOKENS).toContain('--bg: #0a0a0a');
    expect(TOKENS).toContain('--fg: #ededed');
  });

  it('emits a keyboard-only focus ring (WCAG 2.4.7)', () => {
    expect(TOKENS).toMatch(/:focus-visible[\s\S]*outline:.*var\(--accent-strong\)/);
  });

  it('defines shared .site-header / .site-nav / .site-footer classes', () => {
    expect(TOKENS).toContain('.site-header');
    expect(TOKENS).toContain('.site-nav');
    expect(TOKENS).toContain('.site-footer');
    expect(TOKENS).toContain('.site-brand .mark-accent');
  });
});

describe('renderNav', () => {
  it('emits the bharatlas wordmark with the accented suffix', () => {
    const html = renderNav('catalog');
    expect(html).toContain('<a class="site-brand"');
    expect(html).toContain('bharat<span class="mark-accent">las</span>');
    expect(html).toContain("India's open atlas");
  });

  it('marks the active link with data-active', () => {
    const html = renderNav('verify');
    expect(html).toMatch(/href="\/verify"[^>]*\bdata-active\b/);
    expect(html).not.toMatch(/href="\/submit"[^>]*\bdata-active\b/);
  });

  it('renders every link in NAV_LINKS', () => {
    const html = renderNav('catalog');
    for (const l of NAV_LINKS) {
      expect(html).toContain(`href="${l.href}"`);
      expect(html).toContain(`>${l.label}</a>`);
    }
  });

  it('opens external github link in a new tab', () => {
    const html = renderNav('catalog');
    expect(html).toMatch(/href="https:\/\/github\.com\/urbanmorph\/geodata"[^>]*target="_blank"[^>]*rel="noopener"/);
  });

  it('keeps internal links target-less', () => {
    const html = renderNav('catalog');
    // /verify line should not have target=_blank
    expect(html).toMatch(/href="\/verify"[^>]*>verify<\/a>/);
    expect(html).not.toMatch(/href="\/verify"[^>]*target="_blank"/);
  });

  it('emits a unique active marker even when no key matches', () => {
    const html = renderNav('nonexistent');
    expect(html).not.toContain('data-active');
  });
});

describe('FOOTER', () => {
  it('credits urbanmorph + links code repo + data report', () => {
    expect(FOOTER).toContain('urbanmorph');
    expect(FOOTER).toContain('github.com/urbanmorph/geodata');
    expect(FOOTER).toContain('REPORT.md');
  });

  it('mentions the open-licences policy', () => {
    expect(FOOTER).toMatch(/Open licences only/i);
  });
});
