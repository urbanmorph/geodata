import { describe, it, expect } from 'vitest';
import { renderOgSvg } from '../functions/lib/og-template';

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
