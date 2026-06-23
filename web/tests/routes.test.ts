import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isKnownRoute, STATIC_PAGES } from '../functions/lib/routes';

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
      .sort();
    expect(templatePages).toEqual([...STATIC_PAGES].sort());
  });
});
