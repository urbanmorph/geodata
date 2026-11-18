import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { loadCatalog, loadCatalogVersioned, __resetCatalogForTest, fetchAsset } from '../functions/lib/catalog-loader';

const CATALOG = { layers: [{ id: 'a' }], categories: {} };

function ctxWith(assets: (url: string) => Promise<Response>) {
  return { request: new Request('https://bharatlas.com/api/v1/layers'), env: { ASSETS: { fetch: vi.fn(assets) } } };
}
const ok = (body: unknown) => async () => new Response(JSON.stringify(body));

beforeEach(() => __resetCatalogForTest());
afterEach(() => vi.unstubAllGlobals());

describe('catalog loader', () => {
  it('reads catalog.json through env.ASSETS, not through the zone', async () => {
    const zone = vi.fn();
    vi.stubGlobal('fetch', zone);
    const ctx = ctxWith(ok(CATALOG));
    expect(await loadCatalog(ctx)).toEqual(CATALOG);
    expect(ctx.env.ASSETS.fetch).toHaveBeenCalledWith('https://bharatlas.com/catalog.json');
    expect(zone).not.toHaveBeenCalled();
  });

  it('loads once per isolate, even for parallel callers', async () => {
    const ctx = ctxWith(ok(CATALOG));
    await Promise.all([loadCatalog(ctx), loadCatalog(ctx), loadCatalogVersioned(ctx)]);
    await loadCatalog(ctx);
    expect(ctx.env.ASSETS.fetch.mock.calls.filter(([u]) => u.endsWith('/catalog.json'))).toHaveLength(1);
  });

  it('drops a failed load so the next call tries again', async () => {
    let n = 0;
    const ctx = ctxWith(async () => (++n === 1 ? new Response('no', { status: 503 }) : new Response(JSON.stringify(CATALOG))));
    await expect(loadCatalog(ctx)).rejects.toThrow(/503/);
    expect(await loadCatalog(ctx)).toEqual(CATALOG);
  });

  it('gives a short version that follows the catalog text', async () => {
    const a = await loadCatalogVersioned(ctxWith(ok(CATALOG)));
    __resetCatalogForTest();
    const b = await loadCatalogVersioned(ctxWith(ok(CATALOG)));
    __resetCatalogForTest();
    const c = await loadCatalogVersioned(ctxWith(ok({ ...CATALOG, layers: [] })));
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
    expect(b.version).toBe(a.version);
    expect(c.version).not.toBe(a.version);
  });

  it('gives a new version for a new build with the same catalog (a code-only deploy)', async () => {
    const withBuild = (id: string) => ctxWith(async (url) =>
      new Response(url.endsWith('/build-id.txt') ? id : JSON.stringify(CATALOG)));
    const a = await loadCatalogVersioned(withBuild('build-1'));
    __resetCatalogForTest();
    const b = await loadCatalogVersioned(withBuild('build-2'));
    expect(b.version).not.toBe(a.version);
    expect(b.catalog).toEqual(CATALOG);
  });

  it('fetchAsset falls back to a same-origin fetch without ASSETS (tests, stub contexts)', async () => {
    const zone = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', zone);
    await fetchAsset({ request: new Request('https://x.test/view/a'), env: {} }, '/ward-index/a.json');
    expect(zone).toHaveBeenCalledWith('https://x.test/ward-index/a.json');
  });
});
