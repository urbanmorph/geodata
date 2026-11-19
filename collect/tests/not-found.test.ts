// collect's own 404, like the bharatlas one (#310): an unknown address on
// collect.bharatlas.com used to fall back to the landing with a 200. Pages
// serves dist/404.html with a 404 status for any address nothing else answers;
// it wears collect's header, says what happened, offers the way on, follows
// the light and dark theme, and stays out of search. /c/ map pages keep their
// own noindex rules.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { notFoundHtml, NOT_FOUND_SLOT, renderNotFoundPage } from '../src/not-found';
import { collectTopbarHtml } from '../src/topbar';
import { linkProblemHtml } from '../src/link-problem';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const html = notFoundHtml();
const text = html.replace(/<[^>]+>/g, ' ');

describe('the collect 404 page', () => {
  it("wears collect's header with the bharatlas mark", () => {
    expect(html).toContain(collectTopbarHtml());
    expect(html).toContain('class="brand-mark"');
  });

  it('says what happened and what to do next', () => {
    expect(html).toMatch(/<h1>[^<]+<\/h1>/);
    expect(text).toMatch(/typo/);
    expect(html).toMatch(/<a class="btn primary" href="\/">Make a map<\/a>/);
    expect(html).toContain('href="https://bharatlas.com/layers"');
  });

  it('keeps the site words: no em-dash, no "catalog"', () => {
    expect(text).not.toContain('—');
    expect(text).not.toMatch(/catalog/i);
  });

  it('is a built page: 404.html is a vite entry, noindex, themed by the shared styles', () => {
    const page = read('404.html');
    expect(read('vite.config.ts')).toMatch(/resolve\(__dirname, '404\.html'\)/);
    expect(page).toContain('<meta name="robots" content="noindex" />');
    expect(page).toContain('<meta name="color-scheme" content="light dark" />');
    expect(page).toContain('href="/src/styles.css"');
    expect(page).toContain(NOT_FOUND_SLOT);
    expect(page).not.toMatch(/<script/);
  });

  it('the build fills the slot with the page body', () => {
    const built = renderNotFoundPage(read('404.html'));
    expect(built).not.toContain(NOT_FOUND_SLOT);
    expect(built).toContain(html);
  });

  it('map pages keep their noindex header rule', () => {
    expect(read('public/_headers')).toMatch(/\/c\/\*\n {2}X-Robots-Tag: noindex/);
  });
});

describe('one collect header', () => {
  it('the landing and the link-problem page share it', () => {
    expect(linkProblemHtml()).toContain(collectTopbarHtml());
    expect(read('src/landing.ts')).toContain('${collectTopbarHtml()}');
  });
});
