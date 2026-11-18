import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isKnownRoute, STATIC_PAGES, PUBLIC_PAGES } from '../functions/lib/routes';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('isKnownRoute', () => {
  it('passes the prerendered single-page routes', () => {
    for (const p of ['/', '/about', '/docs', '/mcp', '/preview', '/privacy', '/terms']) {
      expect(isKnownRoute(p), p).toBe(true);
    }
  });

  it('passes function- and redirect-owned subtrees', () => {
    for (const p of [
      '/view/wards_ahmedabad', '/view', '/c/abc123', '/api/v1/nearby',
      '/embed/wards_pune', '/verify', '/submit', '/contribute',
    ]) {
      expect(isKnownRoute(p), p).toBe(true);
    }
  });

  it('passes any path ending in a file (static assets)', () => {
    for (const p of [
      '/assets/index-abc123.js', '/assets/index-abc.css', '/assets/fonts/x.woff2',
      '/og-india.png', '/robots.txt', '/sitemap.xml', '/llms.txt',
      '/catalog.json', '/india-boundary.geojson', '/favicon.ico',
    ]) {
      expect(isKnownRoute(p), p).toBe(true);
    }
  });

  it('rejects extensionless unknown paths (the soft-404 surface)', () => {
    for (const p of [
      '/nonexistent', '/foo', '/wards', '/ward-map', '/abouts',
      '/random/deep/path', '/preview/extra', '/terms/old', '/xyz123',
    ]) {
      expect(isKnownRoute(p), p).toBe(false);
    }
  });

  it('STATIC_PAGES stays in lockstep with the prerendered templates', () => {
    const templatePages = readdirSync(WEB)
      .filter((f) => f.endsWith('.template.html'))
      .map((f) => f.replace('.template.html', ''))
      .map((n) => (n === 'index' ? '' : n))
      .filter((n) => n !== '404') // the 404 page (dist/404.html) is not a route of its own
      .sort();
    expect(templatePages).toEqual([...STATIC_PAGES].sort());
  });

  it('/404 is not a page: it answers 404 like any unknown path', () => {
    expect(isKnownRoute('/404')).toBe(false);
  });
});

describe('pages served straight from public/ (not prerendered)', () => {
  it('the offline page is served, not turned into a 404 (the offline worker caches it)', () => {
    expect(isKnownRoute('/offline/')).toBe(true);
    expect(isKnownRoute('/offline')).toBe(true);
  });
  it('every one exists as public/<name>/index.html', () => {
    for (const name of PUBLIC_PAGES) {
      expect(existsSync(resolve(WEB, 'public', name, 'index.html')), name).toBe(true);
    }
  });
});

describe('/embed/<id>', () => {
  // Pages answers /index.html with a redirect to /, so a rewrite to it found no
  // file; the SPA fallback hid that until dist/404.html turned misses into 404s.
  it('rewrites to the home page by its served path, /', () => {
    expect(readFileSync(resolve(WEB, 'public/_redirects'), 'utf8')).toMatch(/^\/embed\/\*\s+\/\s+200$/m);
  });
});

describe('retired pages', () => {
  it('/submit redirects to /preview; no standalone submit.html (submissions go through /preview + /api/submit)', () => {
    expect(existsSync(resolve(WEB, 'submit.html'))).toBe(false);
    expect(readFileSync(resolve(WEB, 'public/_redirects'), 'utf8')).toMatch(/^\/submit\s+\/preview\s+301$/m);
  });

  it('endpoints nothing calls stay deleted (live tallies: /api/c/useful-counts, /api/c/:id/rate|summary)', () => {
    for (const f of ['functions/api/community/scores.ts', 'functions/api/c/[id].ts']) {
      expect(existsSync(resolve(WEB, f)), f).toBe(false);
    }
  });

  it('the community page renderer takes no dead options', () => {
    const src = readFileSync(resolve(WEB, 'functions/lib/render-view.ts'), 'utf8');
    expect(src).not.toMatch(/alreadyRated|void opts\./);
  });
});

