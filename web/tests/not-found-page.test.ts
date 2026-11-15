// One 404 page for every edge route: branded, noindex, readable in dark mode.
import { describe, it, expect } from 'vitest';
import { notFoundHtml } from '../functions/lib/not-found';

describe('notFoundHtml', () => {
  const html = notFoundHtml('layer not found', "This layer id doesn't exist in the catalog.");

  it('names the site and says what was not found', () => {
    expect(html).toContain('<title>Not found · bharatlas</title>');
    expect(html).toContain('<h1>404: layer not found</h1>');
    expect(html).toContain('doesn&#39;t exist');
    expect(html).not.toContain('geodata');
  });

  it('is noindex, links home, and uses the brand colours in both themes', () => {
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('href="/"');
    expect(html).toContain('#1A2A6C');
    expect(html).toContain('prefers-color-scheme:dark');
  });
});
