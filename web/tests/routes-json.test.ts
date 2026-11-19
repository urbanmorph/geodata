// public/_routes.json keeps static files out of the Functions runtime: with a
// root _middleware and no _routes.json, every asset request ran the Worker.
// Verified with wrangler pages dev (2026-11-19): the same status, type, body
// and security headers for pages, soft 404s, /view, /c, /releases, /api, /og
// and assets, with and without the file. This test keeps every Function route
// out of the exclude list.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const routes = JSON.parse(readFileSync(resolve(__dirname, '../public/_routes.json'), 'utf8')) as { version: number; include: string[]; exclude: string[] };
const FN_DIR = resolve(__dirname, '../functions');

/** URL prefixes Pages Functions own, from functions/ (lib/ is not routed). */
function functionPaths(dir = FN_DIR, base = ''): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (base === '' && f === 'lib') return [];
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return functionPaths(p, `${base}/${f}`);
    const name = f.replace(/\.ts$/, '');
    if (name === '_middleware') return [];
    return [`${base}/${name}`.replace(/\[[^\]]+\]/g, 'x')];
  });
}

const excluded = (path: string) => routes.exclude.some((r) => (r.endsWith('/*') ? path.startsWith(r.slice(0, -1)) : path === r));

describe('public/_routes.json', () => {
  it('runs Functions everywhere but the listed static files (max 100 rules)', () => {
    expect(routes.version).toBe(1);
    expect(routes.include).toEqual(['/*']);
    expect(routes.include.length + routes.exclude.length).toBeLessThanOrEqual(100);
  });
  it('never excludes a Function route', () => {
    const fns = functionPaths();
    expect(fns).toEqual(expect.arrayContaining(['/sitemap.xml', '/robots.txt', '/api/v1/openapi.json', '/og/view/x.png', '/mcp']));
    expect(fns.filter(excluded)).toEqual([]);
  });
  it('excludes only exact files or whole static folders', () => {
    for (const r of routes.exclude) expect(r).toMatch(/^\/[A-Za-z0-9._-]+(\/\*)?$/);
  });
});
