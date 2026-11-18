// Small fixes from the owner's screenshots (2026-11-18).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchSummaryHtml } from '../src/search-pop';
import { skyLinkHtml } from '../src/locate-actions';

describe('the search result line leads somewhere', () => {
  // The list closes when focus leaves; "2 layers match" alone then pointed nowhere.
  it('links the count to the matching layers on /layers', () => {
    expect(matchSummaryHtml(2, 'bengaluru wards')).toBe(
      '<a href="/layers?q=bengaluru%20wards">2 layers match &quot;bengaluru wards&quot;</a>');
  });
  it('escapes the query', () => {
    expect(matchSummaryHtml(1, '<b>x')).not.toContain('<b>');
  });
  it('the home search uses it', () => {
    expect(readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8')).toMatch(/searchMeta\.innerHTML = matchSummaryHtml\(/);
  });
});

describe('the mugilu link in the locate card', () => {
  it('names the ward and says what is there', () => {
    const html = skyLinkHtml('https://mugilu.live/c/12.97,77.59?utm_source=bharatlas&utm_medium=ward_locate', 'Ward 67');
    expect(html).toContain('Air quality and weather in Ward 67 right now');
    expect(html).toContain('mugilu');
    expect(html).toMatch(/target="_blank" rel="noopener"/);
    expect(skyLinkHtml('https://x', '<i>')).not.toContain('<i>');
  });
  it('sits apart from the buttons above it', () => {
    expect(readFileSync(resolve(__dirname, '../index.template.html'), 'utf8')).toMatch(/\.ls-sky \{[^}]*margin-top: 14px/);
  });
});
