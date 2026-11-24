import { describe, it, expect, beforeEach } from 'vitest';
import { releaseRoute, __resetReleaseIndexForTest } from '../functions/lib/releases';

beforeEach(() => __resetReleaseIndexForTest());
import { onRequestGet as releasesFn, onRequestHead as releasesHead } from '../functions/releases/[[path]]';
import { onRequestGet as apiReleases } from '../functions/api/v1/releases';
import { isKnownRoute } from '../functions/lib/routes';

// the bucket's address (r2-keys.ts R2_PUBLIC_BASE): its custom domain since Nov 2026
const R2 = 'https://data.bharatlas.com';

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

  it('sends a release data file to the same key on R2, once the release is checked to list it', () => {
    expect(releaseRoute(['bharatlas-cw-2026.11', 'cw_villages.parquet'])).toEqual({
      kind: 'data', sums: '/releases/bharatlas-cw-2026.11/SHA256SUMS', file: 'cw_villages.parquet',
      location: `${R2}/releases/bharatlas-cw-2026.11/cw_villages.parquet`,
    });
  });

  it('sends a bare release address (where w3id.org points) to its manifest', () => {
    expect(releaseRoute(['bharatlas-catalog-2026.11'])).toEqual({
      kind: 'redirect', location: '/releases/bharatlas-catalog-2026.11/manifest.json', status: 302,
    });
  });

  it('serves /releases and /releases/<dataset> as pages, and resolves /releases/<dataset>/latest', () => {
    expect(releaseRoute([])).toEqual({ kind: 'page', dataset: null });
    expect(releaseRoute(['cw'])).toEqual({ kind: 'page', dataset: 'cw' });
    expect(releaseRoute(['lgd_states'])).toEqual({ kind: 'page', dataset: 'lgd_states' });
    expect(releaseRoute(['cw', 'latest'])).toEqual({ kind: 'latest', dataset: 'cw', file: null });
    expect(releaseRoute(['cw', 'latest', 'cw_states.csv'])).toEqual({ kind: 'latest', dataset: 'cw', file: 'cw_states.csv' });
    expect(releaseRoute(['cw', 'latest', '..'])).toEqual({ kind: 'notfound' });
    expect(releaseRoute(['cw', 'nope'])).toEqual({ kind: 'notfound' });
    expect(releaseRoute(['CW'])).toEqual({ kind: 'notfound' });
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
  // the committed SHA256SUMS of the one release that exists here, and the index; any other path is the SPA fallback
  const SUMS = 'aa11  cw_states.csv\nbb22  cw_states.parquet\n';
  const INDEX = { latest: { cw: 'bharatlas-cw-2026.11' }, releases: [{ code: 'bharatlas-cw-2026.11', dataset: 'cw' }] };
  const assets = {
    fetch: async (req: Request | string) => {
      const path = new URL(typeof req === 'string' ? req : req.url).pathname;
      if (path === '/releases/bharatlas-cw-2026.11/SHA256SUMS') {
        return new Response(SUMS, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      if (path === '/releases/index.json') return new Response(JSON.stringify(INDEX), { status: 200 });
      return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  };
  const ctx = (path: string[]) => ({
    params: { path },
    request: new Request(`https://bharatlas.com/releases/${path.join('/')}`),
    next: async () => new Response('static', { status: 200 }),
    env: { ASSETS: assets },
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

  it('404s a data file its release does not list, or of a release that does not exist, without sending anyone to R2', async () => {
    for (const path of [['bharatlas-cw-2026.11', 'nope.csv'], ['bharatlas-cw-1999.01', 'cw_states.csv']]) {
      const r = await releasesFn(ctx(path));
      expect(r.status).toBe(404);
      expect(r.headers.get('location')).toBeNull();
    }
  });

  it('turns the single-page-app fallback for a release that does not exist into a 404', async () => {
    const spa = { ...ctx(['bharatlas-cw-1999.01', 'manifest.json']),
      next: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) };
    expect((await releasesFn(spa)).status).toBe(404);
  });

  it('serves the /releases pages as built, and a 404 page for a dataset with no releases', async () => {
    const page = (path: string[]) => ({ ...ctx(path),
      next: async () => new Response('<!doctype html><h1>Releases</h1>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) });
    for (const path of [[], ['cw']]) {
      const r = await releasesFn(page(path));
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('<h1>Releases</h1>');
    }
    const missing = await releasesFn(page(['nope']));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('text/html');
  });

  it('sends /releases/<dataset>/latest to the newest release, and a file to that release\'s file', async () => {
    const r = await releasesFn(ctx(['cw', 'latest']));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/releases/bharatlas-cw-2026.11');
    expect(r.headers.get('cache-control')).toContain('max-age=300');
    const f = await releasesFn(ctx(['cw', 'latest', 'cw_states.csv']));
    expect(f.headers.get('location')).toBe('/releases/bharatlas-cw-2026.11/cw_states.csv');
    expect((await releasesFn(ctx(['nope', 'latest']))).status).toBe(404);
  });

  it('answers HEAD as GET, so link checkers see the redirect, not the site’s HTML page', async () => {
    const r = await releasesHead(ctx(['bharatlas-cw-2026.11']));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/releases/bharatlas-cw-2026.11/manifest.json');
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
