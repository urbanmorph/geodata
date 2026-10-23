// Graceful offline fallback for bharatlas.com. Its maps and data load from the
// internet, so it is not an offline app, but losing the connection should say so:
// the site's own offline page instead of the browser's error, and a plain message
// when a layer can't load for lack of a connection.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { layerLoadErrorText } from '../src/layer-errors';

const pub = (f: string) => readFileSync(resolve(__dirname, '..', 'public', f), 'utf8');
const OFFLINE = pub('offline/index.html');
const SW = pub('sw.js');

describe('offline page', () => {
  it('says why, offers "Try again" and home, and stays out of search', () => {
    expect(OFFLINE).toContain('<meta name="robots" content="noindex">');
    expect(OFFLINE).toMatch(/<h1>You're offline<\/h1>/);
    expect(OFFLINE).toContain('needs a connection');
    expect(OFFLINE).toMatch(/<a [^>]*href=""[^>]*>Try again/);
    expect(OFFLINE).toMatch(/<a [^>]*href="\/"/);
    expect(OFFLINE).toContain('viewport-fit=cover');
    expect(OFFLINE).toContain('prefers-color-scheme: dark');
    expect(pub('sitemap.xml')).not.toContain('offline');
  });
});

describe('offline worker', () => {
  it('caches only the offline page and answers only page loads that fail', () => {
    // A directory page: Cloudflare Pages redirects a .html address, which the worker can't cache.
    expect(SW).toMatch(/const OFFLINE = '\/offline\/'/);
    expect(SW).toContain("'navigate'");
    expect(SW.match(/cache\.add\(/g)).toHaveLength(1);
    expect(SW).not.toContain('cache.put(');
  });
  it('ships a new worker whenever the offline page changes (VERSION is its hash)', () => {
    const digest = createHash('sha256').update(OFFLINE).digest('hex').slice(0, 12);
    expect(SW).toContain(`const VERSION = '${digest}'`);
  });
  it('is served no-cache, so browsers always see a new one', () => {
    expect(pub('_headers')).toMatch(/^\/sw\.js\n\s+Cache-Control: no-cache$/m);
  });
  it('is registered on every prerendered page (through install.ts)', () => {
    const install = readFileSync(resolve(__dirname, '..', 'src', 'install.ts'), 'utf8');
    expect(install).toMatch(/import \{ registerOfflinePage \} from '\.\/offline'/);
    expect(install).toContain('registerOfflinePage();');
  });
});

describe('a layer that cannot load', () => {
  it('for lack of a connection: says so plainly', () => {
    expect(layerLoadErrorText(new TypeError('Failed to fetch'), true)).toBe(
      "No connection: this layer needs the internet to load. Try again when you're back online.",
    );
    expect(layerLoadErrorText(new Error('anything'), false)).toMatch(/^No connection/);
  });
  it('for any other reason: keeps the technical message', () => {
    expect(layerLoadErrorText(new Error('HTTP 404'), true)).toBe('failed to load layer: HTTP 404');
  });
});
