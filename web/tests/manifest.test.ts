import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { manifestProblems, manifestContentType, readManifest, screenshotProblems, MANIFEST_LINK } from './helpers/manifest-checks';
// @ts-expect-error — .mjs import resolves at test time, no type defs
import { renderNav } from '../scripts/shared-chrome.mjs';

const root = resolve(__dirname, '..');
const pub = resolve(root, 'public');

describe('bharatlas.com web app manifest', () => {
  it('has narrow + wide screenshots for the richer install dialog (real sizes, within Chrome\'s limits)', () => {
    expect(screenshotProblems(pub)).toEqual([]);
  });
  it('meets the install criteria', () => {
    expect(manifestProblems(pub, '#ffffff')).toEqual([]);
    const m = readManifest(pub);
    expect(m.start_url).toBe('/');
    expect(m.id).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.short_name).toBe('bharatlas');
  });

  it('is served as application/manifest+json', () => {
    expect(manifestContentType(readFileSync(resolve(pub, '_headers'), 'utf8'))).toBe('application/manifest+json');
  });

  it('is linked from every prerendered page template', () => {
    const templates = readdirSync(root).filter((f) => f.endsWith('.template.html'));
    expect(templates.length).toBeGreaterThan(5);
    for (const t of templates) expect(readFileSync(resolve(root, t), 'utf8'), t).toContain(MANIFEST_LINK);
  });
});

describe('install button in the shared header', () => {
  it('renders a hidden Install app button and the script that wires it', () => {
    const html = renderNav('catalog');
    expect(html).toMatch(/<button[^>]*id="install-app"[^>]*\bhidden\b[^>]*>[^<]*Install app<\/button>/);
    expect(html).toContain('<script type="module" src="/src/install.ts"></script>');
  });
});
