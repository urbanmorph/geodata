// The one SEO head (title, description, canonical, OG/Twitter, JSON-LD) that
// prerender.mjs and releases-page.mjs both emit, and the BreadcrumbList helper.
import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain .mjs
import { seoHead, crumbs, HEAD_ICONS } from '../scripts/seo-head.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { ogImage } from '../scripts/og-image-url.mjs';

describe('crumbs', () => {
  it('builds a BreadcrumbList, Home first, absolute item URLs', () => {
    expect(crumbs(['About', '/about'])).toEqual({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://bharatlas.com/' },
        { '@type': 'ListItem', position: 2, name: 'About', item: 'https://bharatlas.com/about' },
      ],
    });
  });
});

describe('seoHead', () => {
  const base = { title: 'About', description: 'A & b', url: 'https://bharatlas.com/about' };

  it('suffixes the title, escapes text and defaults the share image', () => {
    const h = seoHead(base);
    expect(h).toContain('<title>About · bharatlas</title>');
    expect(h).toContain('<meta name="description" content="A &amp; b" />');
    expect(h).toContain(`<meta property="og:image" content="${ogImage('og-default')}" />`);
    expect(h).toContain('<meta property="og:locale" content="en_IN" />');
    expect(h).toContain('<meta name="twitter:title" content="About · bharatlas" />');
    expect(h).not.toContain('ld+json');
  });

  it('escapes < in JSON-LD', () => {
    const h = seoHead({ ...base, structuredData: { name: '</script>' } });
    expect(h).toContain('<script type="application/ld+json">{"name":"\\u003c/script>"}</script>');
  });

  it('brief leaves out og:locale and the twitter title and description', () => {
    const h = seoHead({ ...base, brief: true });
    expect(h).not.toContain('og:locale');
    expect(h).not.toContain('twitter:title');
    expect(h).not.toContain('twitter:description');
    expect(h).toContain('twitter:image');
  });
});

describe('HEAD_ICONS', () => {
  const WEB = resolve(__dirname, '..');
  const templates = readdirSync(WEB).filter((f) => f.endsWith('.template.html'));

  it('carries the icons, the manifest and both theme colours', () => {
    for (const s of ['/favicon.svg', '/favicon-32.png', '/favicon.ico', '/apple-touch-icon.png', '/manifest.webmanifest']) expect(HEAD_ICONS).toContain(s);
    expect(HEAD_ICONS.match(/name="theme-color"/g)).toHaveLength(2);
  });

  it('every page template takes it from the one placeholder', () => {
    expect(templates.length).toBeGreaterThan(0);
    for (const f of templates) {
      const t = readFileSync(resolve(WEB, f), 'utf8');
      expect(t, f).toContain('<!-- HEAD_ICONS -->');
      expect(t, f).not.toContain('href="/favicon.svg"');
    }
  });
});
