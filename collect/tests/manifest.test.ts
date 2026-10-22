import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { manifestProblems, manifestContentType, readManifest, MANIFEST_LINK } from '../../web/tests/helpers/manifest-checks';

const root = resolve(__dirname, '..');
const pub = resolve(root, 'public');

describe('collect web app manifest', () => {
  it('meets the install criteria and opens on "Your maps"', () => {
    expect(manifestProblems(pub, '#ffffff')).toEqual([]);
    const m = readManifest(pub);
    expect(m.start_url).toBe('/');
    expect(m.id).toBe('/');
    expect(m.scope).toBe('/'); // map links (/c/…) open inside the installed app too
    expect(m.short_name).toBe('collect');
  });

  it('is served as application/manifest+json', () => {
    expect(manifestContentType(readFileSync(resolve(pub, '_headers'), 'utf8'))).toBe('application/manifest+json');
  });

  it('is linked from both HTML shells (landing + map app)', () => {
    for (const f of ['index.html', 'c.html']) {
      const html = readFileSync(resolve(root, f), 'utf8');
      expect(html, f).toContain(MANIFEST_LINK);
      expect(html, f).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    }
  });

  it('CSP leaves manifest + icons on self (no manifest-src / img-src override that blocks them)', () => {
    const csp = readFileSync(resolve(pub, '_headers'), 'utf8').match(/Content-Security-Policy:\s*([^\n]+)/)![1];
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).not.toMatch(/manifest-src/);
    expect(csp).toMatch(/img-src 'self'/);
  });
});
