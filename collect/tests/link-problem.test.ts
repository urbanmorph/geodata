// A link that doesn't open a map (cut short, deleted map, replaced link): say
// why in plain words, and what to do next, in collect's own look.
import { describe, it, expect } from 'vitest';
import { linkProblemHtml, isLinkProblem } from '../src/link-problem';
import { ApiError } from '../src/api';

const html = linkProblemHtml();
const text = html.replace(/<[^>]+>/g, ' ');

describe('the page for a link that does not open a map', () => {
  it('wears the collect header with the bharatlas mark', () => {
    expect(html).toContain('class="topbar"');
    expect(html).toContain('class="collect-name"');
    expect(html).toContain('class="brand-mark"');
  });

  it('explains the likely reasons in plain words', () => {
    expect(text).toMatch(/copied incompletely/i);
    expect(text).toMatch(/after the #/);
    expect(text).toMatch(/deleted/);
    expect(text).toMatch(/replaced/);
  });

  it('offers the next steps: make a map, or ask for a fresh link', () => {
    expect(html).toMatch(/<a class="btn primary" href="\/">Make a map<\/a>/);
    expect(text).toMatch(/Ask whoever shared it for a fresh link/);
  });

  it('keeps the site words: no em-dash, no "catalog"', () => {
    expect(text).not.toContain('—');
    expect(text).not.toMatch(/catalog/i);
  });
});

describe('which failures are link problems', () => {
  it('a turned-off, replaced or unknown link (401) is', () => {
    expect(isLinkProblem(new ApiError('unauthorised', 401))).toBe(true);
  });
  it('being offline or rate-limited is not', () => {
    expect(isLinkProblem(new Error('offline'))).toBe(false);
    expect(isLinkProblem(new ApiError('rate limit', 429))).toBe(false);
  });
});
