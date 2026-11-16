import { describe, it, expect } from 'vitest';
import { renderOgSvg, renderOgHeroSvg, textWidth, TITLE_MAX_W } from '../functions/lib/og-template';

describe('renderOgSvg — shape', () => {
  it('emits a 1200×630 SVG with the bg gradient and India path', () => {
    const svg = renderOgSvg({ title: 'Test' });
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    expect(svg).toContain('viewBox="0 0 1200 630"');
    expect(svg).toContain('linearGradient id="bg"');
    // India path is reused across all variants.
    expect(svg).toMatch(/<path d="M 101\.0 287\.3/);
  });
});

describe('renderOgSvg — brand', () => {
  it('draws the three-layer mark and a one-colour "bharatlas" on chakra navy', () => {
    const svg = renderOgSvg({ title: 'X' });
    expect(svg).toContain('stop-color="#0B1B3F"');
    expect(svg).toContain('fill="#F28C28"');
    expect(svg).toContain('fill="#12804A"');
    expect(svg).toContain('>bharatlas</text>');
    expect(svg).not.toContain('<tspan');
  });
});

describe('renderOgSvg — content', () => {
  it('renders the title', () => {
    const svg = renderOgSvg({ title: 'Indian villages' });
    expect(svg).toContain('>Indian villages<');
  });

  it('renders an optional subtitle', () => {
    const svg = renderOgSvg({ title: 'X', subtitle: '5,84,615 polygons · LGD' });
    expect(svg).toContain('5,84,615 polygons · LGD');
  });

  it('omits the subtitle text element when not provided', () => {
    const svg = renderOgSvg({ title: 'X' });
    // The subtitle <text x="560" y="320"> shouldn't be present.
    expect(svg).not.toMatch(/y="320"/);
  });

  it('renders an optional uppercase tag pill on the top-right', () => {
    const svg = renderOgSvg({ title: 'X', tag: 'curated' });
    expect(svg).toContain('>CURATED<');
  });

  it('omits the tag pill when not provided', () => {
    const svg = renderOgSvg({ title: 'X' });
    expect(svg).not.toContain('<rect x="980"');
  });

  it('emits the default footer when no override is given', () => {
    const svg = renderOgSvg({ title: 'X' });
    expect(svg).toContain('open licences · attribution per card');
    expect(svg).toContain('bharatlas.com');
  });

  it('honors footerLeft and footerRight overrides', () => {
    const svg = renderOgSvg({
      title: 'X',
      footerLeft: 'Source: LGD · CC0-1.0',
      footerRight: '@bharatlas',
    });
    expect(svg).toContain('Source: LGD · CC0-1.0');
    expect(svg).toContain('@bharatlas');
  });
});

describe('renderOgSvg — escaping', () => {
  it('escapes XML-sensitive characters in the title', () => {
    const svg = renderOgSvg({ title: 'a < b & "c"' });
    expect(svg).toContain('a &lt; b &amp; &quot;c&quot;');
    expect(svg).not.toContain('a < b');
  });

  it('escapes XML-sensitive characters in footer fields', () => {
    const svg = renderOgSvg({ title: 'X', footerLeft: 'one & two', footerRight: '<3' });
    expect(svg).toContain('one &amp; two');
    expect(svg).toContain('&lt;3');
  });
});

describe('renderOgSvg — clipping', () => {
  it('clips a very long title with an ellipsis', () => {
    const svg = renderOgSvg({ title: 'a'.repeat(200) });
    expect(svg).toContain('…');
    // Title runs out before 200 chars.
    expect(svg).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('clips a very long subtitle', () => {
    const svg = renderOgSvg({ title: 'X', subtitle: 'a'.repeat(200) });
    expect(svg).toContain('…');
  });
});

describe('renderOgSvg — fallbacks', () => {
  it('uses "bharatlas" when title is empty', () => {
    const svg = renderOgSvg({ title: '' });
    expect(svg).toContain('>bharatlas<');
  });
});

// Real widths of DM Sans SemiBold (functions/lib/og-widths.json), so a long
// layer name wraps instead of running off the card (it read "Ahmedabad (AMC) Wa").
describe('renderOgSvg — title fitting', () => {
  const titleLines = (svg: string) =>
    [...svg.matchAll(/<text class="title"[^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ size: Number(m[1]), text: m[2] }));

  it('keeps a short title on one line at full size', () => {
    const lines = titleLines(renderOgSvg({ title: 'States (2024)' }));
    expect(lines).toEqual([{ size: 62, text: 'States (2024)' }]);
  });

  it('wraps a long layer name onto two lines, whole, without clipping', () => {
    const lines = titleLines(renderOgSvg({ title: 'Ahmedabad (AMC) Wards (2023)' }));
    expect(lines.length).toBe(2);
    expect(lines.map((l) => l.text).join(' ')).toBe('Ahmedabad (AMC) Wards (2023)');
    for (const l of lines) expect(textWidth(l.text, l.size)).toBeLessThanOrEqual(TITLE_MAX_W);
  });

  it('shrinks and then clips only a title too long for two lines', () => {
    const t = 'Pradhan Mantri Gram Sadak Yojana rural road network habitations and core network (2025)';
    const lines = titleLines(renderOgSvg({ title: t }));
    expect(lines.length).toBe(2);
    expect(lines[0].size).toBeLessThan(62);
    expect(lines[1].text.endsWith('…')).toBe(true);
    for (const l of lines) expect(textWidth(l.text, l.size)).toBeLessThanOrEqual(TITLE_MAX_W);
  });

  it('moves the subtitle below a two-line title', () => {
    const one = renderOgSvg({ title: 'States', subtitle: 'sub' });
    const two = renderOgSvg({ title: 'Ahmedabad (AMC) Wards (2023)', subtitle: 'sub' });
    const y = (s: string) => Number(s.match(/<text class="subtitle"[^>]*y="(\d+)"/)![1]);
    expect(y(two)).toBeGreaterThan(y(one));
  });
});

describe('renderOgSvg — wordmark', () => {
  it('sets "bharatlas" in the heavy (800) weight the site uses', () => {
    expect(renderOgSvg({ title: 'X' })).toMatch(/font-weight="800"[^>]*>bharatlas<\/text>/);
  });
});

// The site-wide share images (og-default/-preview/-about) come from the same
// template as the layer cards (scripts/gen-og-static.mjs), not a separate copy.
describe('renderOgHeroSvg', () => {
  const svg = renderOgHeroSvg({ tagline: 'Every boundary in India,\none search away', sub: 'Free and open data. No sign-up.' });
  it('draws the big heavy wordmark, the tagline and the sub line', () => {
    expect(svg).toMatch(/font-weight="800"[^>]*>bharatlas<\/text>/);
    expect(svg).toContain('Every boundary in India,');
    expect(svg).toContain('Free and open data. No sign-up.');
  });
  it('keeps every tagline line inside the right column', () => {
    const lines = [...svg.matchAll(/<text class="tagline"[^>]*font-size="(\d+)"[^>]*>([^<]*)</g)];
    expect(lines.length).toBeGreaterThan(0);
    for (const m of lines) expect(textWidth(m[2], Number(m[1]))).toBeLessThanOrEqual(TITLE_MAX_W);
  });
  it('the committed share images say the current tagline', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const home = fs.readFileSync(require('node:path').resolve(__dirname, '../public/og-default.svg'), 'utf8');
    expect(home).toContain('one search away');
    expect(home).not.toContain('view · verify · publish');
  });
});
