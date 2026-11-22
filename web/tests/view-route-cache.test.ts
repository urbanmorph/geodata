// /view/<id> and the OG cards: built from the deployment's own files (env.ASSETS)
// and kept in the edge cache, keyed by the deploy version.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../functions/lib/og-render', () => ({ renderOgPng: vi.fn(async () => new Uint8Array([137, 80, 78, 71])) }));
vi.mock('../functions/lib/submissions', () => ({
  getSubmissionForView: vi.fn(async (_db: unknown, id: string) =>
    id === 'abcdefgh' ? { id, name: 'Lakes', category: 'water', format: 'geojson', feature_count: 3, attribution: 'x', updated_at: '2026-11-01' } : null),
}));

import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { renderOgPng } from '../functions/lib/og-render';
import { onRequestGet as viewRoute } from '../functions/view/[id]';
import { onRequestGet as ogView } from '../functions/og/view/[id].png';
import { onRequestGet as ogCommunity } from '../functions/og/c/[id].png';
import { buildWardTable, buildZoneList, type WardIndex } from '../functions/lib/view-dataset';

const CATALOG = {
  layers: [
    { id: 'wards_x', level: 'wards_x', source: 'X Corp', rows: 2 },
    { id: 'dist', level: 'district', source: 'LGD', rows: 6 },
    { id: 'lgd_blocks', level: 'block', source: 'LGD', rows: 7000 },
    { id: 'bhuvan_blocks', level: 'block', source: 'Bhuvan', rows: 6900 },
    { id: 'ir_stations', level: 'ir_stations', source: 'CRIS', rows: 9 },
  ],
};
const WARDS: WardIndex = { place: 'X', nameLabel: 'Name', rows: [{ no: '1', name: 'A', zone: 'N' }, { no: '2', name: 'B', zone: 'S' }] } as WardIndex;

let store: Map<string, Response>;
const assets = {
  fetch: vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/catalog.json') return new Response(JSON.stringify(CATALOG));
    if (path === '/') return new Response('<html><head><title>x</title></head><body></body></html>');
    if (path === '/ward-index/wards_x.json') return new Response(JSON.stringify(WARDS));
    return new Response('nf', { status: 404 });
  }),
};

// workerd's HTMLRewriter isn't in node: pass the page through untouched.
class FakeRewriter {
  on() { return this; }
  transform(r: Response) { return r; }
}

async function call(handler: (ctx: never) => Promise<Response>, path: string, params: Record<string, string>) {
  const pending: Promise<unknown>[] = [];
  const res = await handler({
    request: new Request(`https://bharatlas.com${path}`),
    env: { ASSETS: assets, DB: {} },
    params,
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
  } as never);
  await Promise.all(pending);
  return res;
}

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('caches', {
    default: {
      async match(k: string) { return store.get(k)?.clone(); },
      async put(k: string, r: Response) { store.set(k, r); },
    },
  });
  vi.stubGlobal('HTMLRewriter', FakeRewriter);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no zone fetches'); }));
  assets.fetch.mockClear();
  vi.mocked(renderOgPng).mockClear();
  __resetCatalogForTest();
});
afterEach(() => vi.unstubAllGlobals());

describe('/view/<id>', () => {
  it('reads index.html and the ward index through ASSETS, then serves the stored page', async () => {
    const a = await call(viewRoute, '/view/wards_x', { id: 'wards_x' });
    expect(a.status).toBe(200);
    expect(a.headers.get('x-edge-cache')).toBe('MISS');
    const paths = assets.fetch.mock.calls.map(([u]) => new URL(u).pathname);
    expect(paths).toEqual(expect.arrayContaining(['/catalog.json', '/', '/ward-index/wards_x.json']));
    assets.fetch.mockClear();
    const b = await call(viewRoute, '/view/wards_x?utm_source=x', { id: 'wards_x' });
    expect(b.headers.get('x-edge-cache')).toBe('HIT');
    expect(b.headers.get('content-type')).toContain('text/html');
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('an unknown layer is a 404 and is not stored', async () => {
    const r = await call(viewRoute, '/view/nope', { id: 'nope' });
    expect(r.status).toBe(404);
    expect(store.size).toBe(0);
  });
});

describe('OG cards', () => {
  it('a layer card renders once, then comes from the cache', async () => {
    const a = await call(ogView, '/og/view/dist.png', { id: 'dist' });
    const b = await call(ogView, '/og/view/dist.png', { id: 'dist' });
    expect(a.headers.get('content-type')).toBe('image/png');
    expect(b.headers.get('x-edge-cache')).toBe('HIT');
    expect(renderOgPng).toHaveBeenCalledTimes(1);
  });

  it('a community card renders once per submission version', async () => {
    await call(ogCommunity, '/og/c/abcdefgh.png', { id: 'abcdefgh' });
    const b = await call(ogCommunity, '/og/c/abcdefgh.png', { id: 'abcdefgh' });
    expect(b.headers.get('x-edge-cache')).toBe('HIT');
    expect(renderOgPng).toHaveBeenCalledTimes(1);
    expect([...store.keys()][0]).toContain('2026-11-01');
  });
});

describe('/view and /og/view agree on the layer', () => {
  // An alternate source (Bhuvan blocks next to LGD blocks) is titled as its
  // page is, "Blocks from Bhuvan" (wrapped over two lines on the card), so
  // its siblings' cards differ: not the LGD layer's "Blocks (2024)" nor the bare id.
  it("an alternate source's card title is its page's title", async () => {
    await call(ogView, '/og/view/bhuvan_blocks.png', { id: 'bhuvan_blocks' });
    const svg = String(vi.mocked(renderOgPng).mock.calls[0][0]);
    expect(svg).toContain('>Blocks from<');
    expect(svg).toContain('>Bhuvan<');
    expect(svg).not.toContain('bhuvan blocks');
    expect(svg).not.toContain('(2024)');
  });

  it('the primary layer keeps its level label with the year', async () => {
    await call(ogView, '/og/view/lgd_blocks.png', { id: 'lgd_blocks' });
    expect(String(vi.mocked(renderOgPng).mock.calls[0][0])).toContain('Blocks (2024)');
  });

  for (const [name, handler, path] of [
    ['/view', viewRoute, '/view/'],
    ['/og/view', ogView, '/og/view/'],
  ] as const) {
    const ext = name === '/og/view' ? '.png' : '';
    it(`${name}: a retired id is a 301 to its successor`, async () => {
      const r = await call(handler, `${path}ir_stations_merged${ext}`, { id: 'ir_stations_merged' });
      expect(r.status).toBe(301);
      expect(r.headers.get('location')).toBe(`https://bharatlas.com${path}ir_stations${ext}`);
    });
    it(`${name}: an unknown id is a 404`, async () => {
      const r = await call(handler, `${path}nope${ext}`, { id: 'nope' });
      expect(r.status).toBe(404);
    });
    it(`${name}: a malformed id is a 404`, async () => {
      const r = await call(handler, `${path}a.b${ext}`, { id: 'a.b' });
      expect(r.status).toBe(404);
    });
  }
});

describe('ward tables', () => {
  it('are built once per ward index (the page and its JSON-LD share them)', () => {
    expect(buildWardTable(WARDS)).toBe(buildWardTable(WARDS));
    expect(buildZoneList(WARDS)).toBe(buildZoneList(WARDS));
  });
});
