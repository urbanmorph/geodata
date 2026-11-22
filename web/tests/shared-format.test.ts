// One implementation of escaping and number/date formatting, shared by the
// prerender, the edge functions, the web app and collect (shared/format.mjs).
import { describe, it, expect } from 'vitest';
import { escapeHtml, fmtBytes, fmtCount, fmtDate, fmtInt, ldJsonScript } from '../../shared/format.mjs';

describe('ldJsonScript', () => {
  it('wraps JSON-LD in its script tag, safe inside HTML, and parses back to the same value', () => {
    const ld = { name: 'States & UTs <b>', note: '</script><!--' };
    const tag = ldJsonScript(ld);
    expect(tag.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(tag.endsWith('</script>')).toBe(true);
    const body = tag.slice('<script type="application/ld+json">'.length, -'</script>'.length);
    expect(body).not.toMatch(/[<>&]/);
    expect(JSON.parse(body)).toEqual(ld);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
  it('treats null/undefined as empty and stringifies anything else', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('fmtBytes', () => {
  it('formats B, whole KB, MB and GB; n/a when unknown', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(226794)).toBe('221 KB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(fmtBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(fmtBytes(null)).toBe('n/a');
    expect(fmtInt(null)).toBe('n/a');
    expect(fmtInt(2940912)).toBe('29,40,912');
  });
});

describe('fmtCount', () => {
  it('keeps tenths while they read, then whole units', () => {
    expect(fmtCount(950)).toBe('950');
    expect(fmtCount(22100)).toBe('22.1k');
    expect(fmtCount(250000)).toBe('250k');
    expect(fmtCount(1_200_000)).toBe('1.2M');
  });
});

describe('fmtDate', () => {
  it('formats an ISO date or timestamp as "26 May 2026" in UTC', () => {
    expect(fmtDate('2026-05-26')).toBe('26 May 2026');
    expect(fmtDate('2026-05-26T23:30:00Z')).toBe('26 May 2026');
  });
});
