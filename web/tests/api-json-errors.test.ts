// API answers are JSON, errors included, and the two download-count routes agree
// (review 2026-11-18).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { onRequestGet as v1Counts } from '../functions/api/v1/downloads/counts';
import { onRequestGet as dlCounts } from '../functions/api/dl/counts';
import { onRequestGet as layerRoute } from '../functions/api/v1/layers/[id]';
import { onRequestGet as cRoute, onRequestPut as cPut } from '../functions/api/c/[id]';
import { onRequestGet as releasesRoute } from '../functions/api/v1/releases';
import { onRequestGet as dlRoute } from '../functions/api/dl/[[path]]';
import { onRequestGet as r2Route } from '../functions/api/r2/[[path]]';
import { onRequest as submitOther } from '../functions/api/submit';

// Per-state extracts and the R2 backfill are separate rows for one layer and format.
const rows = [
  { layer_id: 'lgd_states', format: 'parquet', count: 5 },
  { layer_id: 'lgd_states', format: 'parquet', count: 7 },
  { layer_id: 'lgd_states', format: 'geojson', count: 1 },
];
const db = (results: unknown[] | null) => ({
  prepare: () => ({
    all: async () => ({ results }),
    bind: () => ({ first: async () => null }),
  }),
});
const ctx = (url: string, extra: Record<string, unknown> = {}) =>
  ({ request: new Request(url), env: { DB: db(rows) }, params: {}, waitUntil: () => {}, ...extra }) as never;

const isJsonError = async (r: Response, status: number) => {
  expect(r.status).toBe(status);
  expect(r.headers.get('content-type')).toMatch(/^application\/json/);
  expect(typeof (await r.json()).error).toBe('string');
};

afterEach(() => vi.unstubAllGlobals());

describe('/api/v1/downloads/counts', () => {
  it('adds up every row for a layer and format, the same totals as /api/dl/counts', async () => {
    const v1 = await (await v1Counts(ctx('https://b.test/api/v1/downloads/counts'))).json();
    const dl = await (await dlCounts(ctx('https://b.test/api/dl/counts'))).json();
    expect(v1).toEqual({ data: { lgd_states: { parquet: 12, geojson: 1 } }, total: 13 });
    expect(v1.total).toBe(dl._total);
    expect(v1.data.lgd_states).toEqual(dl.lgd_states);
  });
});

describe('API errors are JSON', () => {
  it('/api/v1/layers/:id: a bad id is a 400, an unknown one a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ layers: [] }))));
    await isJsonError(await layerRoute(ctx('https://b.test/api/v1/layers/a.b', { params: { id: 'a.b' } })), 400);
    await isJsonError(await layerRoute(ctx('https://b.test/api/v1/layers/nope', { params: { id: 'nope' } })), 404);
  });

  it('/api/c/:id: not found and not implemented', async () => {
    await isJsonError(await cRoute(ctx('https://b.test/api/c/x', { params: { id: 'x' } })), 404);
    await isJsonError(await cPut(ctx('https://b.test/api/c/x', { params: { id: 'x' } })), 501);
  });

  it('/api/v1/releases: the index unavailable', async () => {
    const env = { ASSETS: { fetch: async () => new Response('<html>', { status: 200 }) } };
    await isJsonError(await releasesRoute(ctx('https://b.test/api/v1/releases', { env })), 500);
  });

  it('/api/dl and /api/r2: a missing key', async () => {
    await isJsonError(await dlRoute(ctx('https://b.test/api/dl/', { params: { path: [] } })), 400);
    await isJsonError(await r2Route(ctx('https://b.test/api/r2/', { params: { path: [] } })), 400);
    await isJsonError(await r2Route(ctx('https://b.test/api/r2/other/x', { params: { path: ['other', 'x'] } })), 404);
  });

  it('/api/submit: a method other than POST', async () => {
    await isJsonError(await submitOther(ctx('https://b.test/api/submit')), 405);
  });
});
