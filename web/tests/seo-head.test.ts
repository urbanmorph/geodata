// The one SEO head (title, description, canonical, OG/Twitter, JSON-LD) that
// prerender.mjs and releases-page.mjs both emit, and the BreadcrumbList helper.
import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain .mjs
import { seoHead, crumbs } from '../scripts/seo-head.mjs';
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
