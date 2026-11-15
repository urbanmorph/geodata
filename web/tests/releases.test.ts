import { describe, it, expect } from 'vitest';
import { releaseRoute } from '../functions/lib/releases';
import { onRequestGet as releasesFn } from '../functions/releases/[[path]]';
import { onRequestGet as apiReleases } from '../functions/api/v1/releases';
import { isKnownRoute } from '../functions/lib/routes';

const R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev';

describe('releaseRoute', () => {
  it('serves the index, manifest, changes and sums as committed static files', () => {
    expect(releaseRoute(['index.json'])).toMatchObject({ kind: 'static', headers: { 'content-type': 'application/json' } });
    expect(releaseRoute(['index.json'])).toMatchObject({ headers: { 'cache-control': expect.stringContaining('max-age=300') } });
    for (const f of ['manifest.json', 'CHANGES.md', 'SHA256SUMS']) {
      expect(releaseRoute(['bharatlas-cw-2026.11', f])).toMatchObject({ kind: 'static', headers: { 'access-control-allow-origin': '*' } });
    }
    expect(releaseRoute(['bharatlas-cw-2026.11', 'SHA256SUMS'])).toMatchObject({ headers: { 'content-type': 'text/plain; charset=utf-8' } });
    expect(releaseRoute(['bharatlas-cw-2026.11', 'CHANGES.md'])).toMatchObject({ headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  });

  it('redirects a release data file to the same key on R2, unchanged', () => {
    expect(releaseRoute(['bharatlas-cw-2026.11', 'cw_villages.parquet'])).toEqual({
      kind: 'redirect', location: `${R2}/releases/bharatlas-cw-2026.11/cw_villages.parquet`, status: 302,
    });
  });

  it('sends a bare release address (where w3id.org will point) to its manifest, and /releases to the index', () => {
    expect(releaseRoute(['bharatlas-catalog-2026.11'])).toEqual({
      kind: 'redirect', location: '/releases/bharatlas-catalog-2026.11/manifest.json', status: 302,
    });
    expect(releaseRoute([])).toEqual({ kind: 'redirect', location: '/releases/index.json', status: 302 });
  });

  it('refuses anything that is not a release code and a plain file name', () => {
    expect(releaseRoute(['not-a-code', 'x.csv'])).toEqual({ kind: 'notfound' });
    expect(releaseRoute(['bharatlas-cw-2026.11', '..'])).toEqual({ kind: 'notfound' });
    expect(releaseRoute(['bharatlas-cw-2026.11', '.hidden'])).toEqual({ kind: 'notfound' });
    expect(releaseRoute(['bharatlas-cw-2026.11', 'a', 'b.csv'])).toEqual({ kind: 'notfound' });
    expect(releaseRoute(['bharatlas-CW-2026.11'])).toEqual({ kind: 'notfound' });
    expect(releaseRoute(['bharatlas-cw-2026.1'])).toEqual({ kind: 'notfound' });
  });
});

describe('the /releases function', () => {
  const ctx = (path: string[]) => ({
    params: { path },
    request: new Request(`https://bharatlas.com/releases/${path.join('/')}`),
    next: async () => new Response('static', { status: 200 }),
  }) as any;

  it('passes static files through, redirects data files, 404s the rest', async () => {
    const idx = await releasesFn(ctx(['index.json']));
    expect(await idx.text()).toBe('static');
    expect(idx.headers.get('access-control-allow-origin')).toBe('*');
    expect(idx.headers.get('content-type')).toBe('application/json');
    const r = await releasesFn(ctx(['bharatlas-cw-2026.11', 'cw_states.csv']));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`${R2}/releases/bharatlas-cw-2026.11/cw_states.csv`);
    expect((await releasesFn(ctx(['nope']))).status).toBe(404);
  });

  it('turns the single-page-app fallback for a release that does not exist into a 404', async () => {
    const spa = { ...ctx(['bharatlas-cw-1999.01', 'manifest.json']),
      next: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) };
    expect((await releasesFn(spa)).status).toBe(404);
  });

  it('is a known route, so the soft-404 guard leaves /releases/<code> alone', () => {
    expect(isKnownRoute('/releases/bharatlas-cw-2026.11')).toBe(true);
    expect(isKnownRoute('/releases')).toBe(true);
  });
});

describe('GET /api/v1/releases', () => {
  it('returns the release index in the API envelope', async () => {
    const index = { latest: { cw: 'bharatlas-cw-2026.11' }, releases: [{ code: 'bharatlas-cw-2026.11' }] };
    const env = { ASSETS: { fetch: async (u: string | Request) => {
      expect(String(u instanceof Request ? u.url : u)).toBe('https://bharatlas.com/releases/index.json');
      return new Response(JSON.stringify(index));
    } } };
    const r = await apiReleases({ request: new Request('https://bharatlas.com/api/v1/releases'), env } as any);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: index });
  });

  it('answers 500 in the error shape when the index cannot be read', async () => {
    for (const answer of [new Response('', { status: 404 }), new Response('<!doctype html>', { status: 200 })]) {
      const env = { ASSETS: { fetch: async () => answer } };
      const r = await apiReleases({ request: new Request('https://bharatlas.com/api/v1/releases'), env } as any);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: 'release index unavailable', status: 500 });
    }
  });
});
