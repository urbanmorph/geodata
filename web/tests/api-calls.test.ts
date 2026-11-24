// How fast the API and MCP are for real callers (owner, 2026-11-23): every counted
// /api/v1 call (one usage.ts counts) writes one Analytics Engine data point with its
// subject, channel, MCP version, colo, status, time, whether the colo's cache answered,
// and for the point lookups the filter used, R2 reads, colo hits and partial layers.
// Never an IP, a coordinate or anything that tells callers apart. Recording never slows
// or fails a call.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { callDataPoint, callRoute, filterUsed, mcpVersion, timedCall, API_CALLS_DATASET } from '../functions/lib/api-calls';
import { countApiUse, timeOnly } from '../functions/lib/usage';
import { profileHandler } from '../functions/lib/profile-endpoint';
import { SURFACE_PROFILE } from '../functions/lib/surface';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');

/** A fake Analytics Engine dataset that keeps what is written. */
const dataset = () => {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, writeDataPoint: (p?: AnalyticsEngineDataPoint) => { if (p) points.push(p); } };
};

const req = (url: string, ua = 'curl/8', cf?: Record<string, unknown>) => {
  const r = new Request(url, { headers: { 'user-agent': ua, 'cf-connecting-ip': '203.0.113.9' } });
  if (cf) Object.defineProperty(r, 'cf', { value: cf });
  return r;
};

describe('mcpVersion', () => {
  it('the bharatlas MCP version, "hosted" for the hosted server, nothing for other callers', () => {
    expect(mcpVersion('bharatlas-mcp/1.7.0')).toBe('1.7.0');
    expect(mcpVersion('bharatlas-mcp/hosted')).toBe('hosted');
    expect(mcpVersion('bharatlas-mcp/1.10.2-beta.1 (node)')).toBe('1.10.2-beta.1');
    expect(mcpVersion('curl/8.4.0')).toBe('');
    expect(mcpVersion(null)).toBe('');
  });
  it('anything else after the prefix is "other": free text a caller wrote is never kept', () => {
    expect(mcpVersion('bharatlas-mcp/jane@example.com')).toBe('other');
    expect(mcpVersion(`bharatlas-mcp/1.2.3${'x'.repeat(50)}`)).toBe('other');
  });
});

describe('callRoute', () => {
  it('names the kind of call, never the layer (the subject carries that)', () => {
    expect(callRoute('/api/v1/ground')).toBe('ground');
    expect(callRoute('/api/v1/surface')).toBe('surface');
    expect(callRoute('/api/v1/nearby')).toBe('nearby');
    expect(callRoute('/api/v1/layers/lgd_states')).toBe('detail');
    expect(callRoute('/api/v1/layers/lgd_states/query')).toBe('query');
    expect(callRoute('/api/v1/layers/lgd_states/export')).toBe('export');
  });
});

describe('filterUsed', () => {
  it('which of sections= and layers= a point lookup was narrowed by', () => {
    expect(filterUsed(new URLSearchParams('lat=1&lng=2'))).toBe('');
    expect(filterUsed(new URLSearchParams('sections=soil'))).toBe('sections');
    expect(filterUsed(new URLSearchParams('layers=a,b'))).toBe('layers');
    expect(filterUsed(new URLSearchParams('layers=a&sections=soil'))).toBe('sections+layers');
    expect(filterUsed(new URLSearchParams('sections='))).toBe('');
  });
});

describe('callDataPoint', () => {
  it('lays a point lookup out in fixed positions', () => {
    const r = req('https://bharatlas.com/api/v1/ground?lat=28.5123&lng=77.1456&sections=soil', 'bharatlas-mcp/1.7.0', { colo: 'SIN' });
    const p = callDataPoint(r, { subject: 'endpoint:ground', channel: 'mcp', reads: 12, coloHits: 30, partial: 1 }, 200, 840.4, 'MISS');
    expect(p).toEqual({
      indexes: ['endpoint:ground'],
      blobs: ['endpoint:ground', 'mcp', '1.7.0', 'SIN', 'miss', 'sections', 'ground'],
      doubles: [840, 200, 12, 30, 1],
    });
  });
  it('a layer call: cache hit, no lookup numbers, an odd colo left out', () => {
    const r = req('https://bharatlas.com/api/v1/layers/lgd_states/query?where=state:Goa', 'curl/8', { colo: 'not a colo' });
    const p = callDataPoint(r, { subject: 'lgd_states', channel: 'api' }, 200, 3, 'HIT');
    expect(p.blobs).toEqual(['lgd_states', 'api', '', '', 'hit', '', 'query']);
    expect(p.doubles).toEqual([3, 200, 0, 0, 0]);
  });
  it('a stale answer served while it refreshes (edge-cache.ts) is a hit: it came from the cache', () => {
    const p = callDataPoint(req('https://bharatlas.com/api/v1/layers/x/query'), { subject: 'x', channel: 'api' }, 200, 3, 'STALE');
    expect(p.blobs?.[4]).toBe('hit');
    expect(callDataPoint(req('https://bharatlas.com/api/v1/layers/x/query'), { subject: 'x', channel: 'api' }, 200, 3, 'KV').blobs?.[4]).toBe('hit');
  });
  it('an answer the colo never keeps (an error, an uncached route) is "none"', () => {
    const p = callDataPoint(req('https://bharatlas.com/api/v1/nearby?layer=x&lat=1&lng=2'), { subject: 'x', channel: 'api' }, 500, 10, null);
    expect(p.blobs?.[4]).toBe('none');
  });
  it('holds no coordinate, IP or query text', () => {
    const r = req('https://bharatlas.com/api/v1/ground?lat=28.5123&lng=77.1456&layers=wris_aquifers', 'bharatlas-mcp/1.7.0', { colo: 'BOM', city: 'Mumbai' });
    const s = JSON.stringify(callDataPoint(r, { subject: 'endpoint:ground', channel: 'mcp' }, 200, 1, 'MISS'));
    for (const secret of ['28.5', '77.1', '203.0.113.9', 'Mumbai', 'wris_aquifers']) expect(s).not.toContain(secret);
  });
});

describe('timedCall', () => {
  const ctxFor = (request: Request, env: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    return { request, env, params: {}, data: {}, waitUntil: (p: Promise<unknown>) => waits.push(p) } as never;
  };
  const counted = timedCall(async (ctx) => { countApiUse(ctx, 'lgd_states'); return new Response('{}', { headers: { 'x-edge-cache': 'MISS' } }); });

  it('writes one data point for a counted call', async () => {
    const ds = dataset();
    const res = await counted(ctxFor(req('https://bharatlas.com/api/v1/layers/lgd_states', 'curl/8', { colo: 'DEL' }), { API_CALLS: ds }));
    expect(res.status).toBe(200);
    expect(ds.points).toHaveLength(1);
    expect(ds.points[0].blobs?.slice(0, 5)).toEqual(['lgd_states', 'api', '', 'DEL', 'miss']);
  });
  it('writes nothing for a call that was not counted: a 400, a crawler, a preview', async () => {
    const ds = dataset();
    await timedCall(async () => new Response('bad', { status: 400 }))(ctxFor(req('https://bharatlas.com/api/v1/nearby'), { API_CALLS: ds }));
    await counted(ctxFor(req('https://bharatlas.com/api/v1/layers/x', 'Googlebot/2.1'), { API_CALLS: ds }));
    await counted(ctxFor(req('https://feat-x.geodata-3ij.pages.dev/api/v1/layers/x'), { API_CALLS: ds }));
    expect(ds.points).toHaveLength(0);
  });
  it('a missing binding or a failing write never fails the call', async () => {
    expect((await counted(ctxFor(req('https://bharatlas.com/api/v1/layers/x'), {}))).status).toBe(200);
    const broken = { writeDataPoint: () => { throw new Error('quota'); } };
    expect((await counted(ctxFor(req('https://bharatlas.com/api/v1/layers/x'), { API_CALLS: broken }))).status).toBe(200);
  });
  it('a handler that throws is recorded as a 500 and still throws', async () => {
    const ds = dataset();
    const boom = timedCall(async (ctx) => { countApiUse(ctx, 'lgd_states'); throw new Error('boom'); });
    await expect(boom(ctxFor(req('https://bharatlas.com/api/v1/layers/x'), { API_CALLS: ds }))).rejects.toThrow('boom');
    expect(ds.points[0].doubles?.[1]).toBe(500);
  });
});

describe('timeOnly', () => {
  const located = timedCall(async (ctx) => { timeOnly(ctx.request, 'endpoint:locate'); return new Response('{}'); });
  const ctxOf = (request: Request, env: Record<string, unknown>) => ({ request, env, waitUntil: () => {} });
  it('records the call\'s speed under its subject, by the same rules as a counted call', async () => {
    const ds = dataset();
    await located(ctxOf(req('https://bharatlas.com/api/v1/locate?lat=1&lng=2', 'bharatlas-mcp/1.7.0'), { API_CALLS: ds }));
    await located(ctxOf(req('https://bharatlas.com/api/v1/locate', 'Googlebot/2.1'), { API_CALLS: ds }));
    await located(ctxOf(req('https://feat-x.geodata-3ij.pages.dev/api/v1/locate'), { API_CALLS: ds }));
    expect(ds.points.map((p) => p.blobs?.slice(0, 3))).toEqual([['endpoint:locate', 'mcp', '1.7.0']]);
  });
  it('writes nothing to the usage tables', async () => {
    let d1 = 0;
    const DB = { prepare: () => { d1++; throw new Error('no'); }, batch: async () => { d1++; return []; } };
    await located(ctxOf(req('https://bharatlas.com/api/v1/locate'), { DB, API_CALLS: dataset() }));
    expect(d1).toBe(0);
  });
});

describe('a point lookup records its reads, colo hits and partial layers', () => {
  it('a computed answer carries them; the colo cache hit that follows does not', async () => {
    const store = new Map<string, Response>();
    const g = globalThis as { caches?: unknown };
    const before = g.caches;
    g.caches = { default: { match: async (k: RequestInfo) => store.get(String(k))?.clone(), put: async (k: RequestInfo, r: Response) => { store.set(String(k), r); } } };
    try {
      const R2 = { get: async (key: string) => ({ key, size: 8, etag: 'e', httpEtag: '"e"', httpMetadata: {}, arrayBuffer: async () => new ArrayBuffer(4) }) };
      const handler = profileHandler('surface', SURFACE_PROFILE, async (lat, lng, _c, r2) => {
        await (await r2.get('a/dem.tif', { range: { offset: 0, length: 4 } }) as R2ObjectBody).arrayBuffer();
        return { point: { lat, lng }, summary: '', disclaimer: '', sections: {}, unavailable: [{ layer_id: 'x', reason: 'not published yet' }], attribution: [], timing_ms: 0, layer_timing_ms: {} };
      }, 'v');
      const ASSETS = { fetch: async (u: string) => (u.endsWith('catalog.json') ? new Response('{"layers":[]}') : new Response('', { status: 404 })) };
      const ds = dataset();
      const call = async () => {
        const waits: Promise<unknown>[] = [];
        await handler({
          request: req(`https://bharatlas.com/api/v1/surface?lat=21.5&lng=77.1&layers=${SURFACE_PROFILE.pixels[0].id}`, 'bharatlas-mcp/hosted', { colo: 'SIN' }),
          env: { ASSETS, R2, POINT_PROFILES: 'on', API_CALLS: ds }, params: {}, data: {}, waitUntil: (p: Promise<unknown>) => waits.push(p),
        } as never);
        await Promise.all(waits);
      };
      await call();
      await call();
      expect(ds.points.map((p) => p.blobs)).toEqual([
        ['endpoint:surface', 'mcp', 'hosted', 'SIN', 'miss', 'layers', 'surface'],
        ['endpoint:surface', 'mcp', 'hosted', 'SIN', 'hit', 'layers', 'surface'],
      ]);
      expect(ds.points[0].doubles?.slice(2)).toEqual([1, 0, 0]); // one read, no colo hit, nothing missed by chance
      expect(ds.points[1].doubles?.slice(2)).toEqual([0, 0, 0]);
    } finally {
      g.caches = before;
    }
  });
});

describe('every counted /api/v1 call is timed', () => {
  it('each handler that counts its calls is wrapped in timedCall', () => {
    for (const f of ['nearby.ts', 'layers/[id].ts', 'layers/[id]/query.ts', 'layers/[id]/schema.ts', 'layers/[id]/counts.ts', 'layers/[id]/export.ts']) {
      const src = read(`functions/api/v1/${f}`);
      expect(src, f).toMatch(/countApiUse\(/);
      expect(src, f).toMatch(/export const onRequestGet(: PagesFunction<Env>)? = timedCall\(/);
    }
    expect(read('functions/lib/profile-endpoint.ts')).toMatch(/return timedCall\(/);
  });
  it('/locate is timed but not counted as use (the viewer calls it on every tap)', () => {
    const src = read('functions/api/v1/locate.ts');
    expect(src).toMatch(/export const onRequestGet(: PagesFunction<Env>)? = timedCall\(/);
    expect(src).toMatch(/timeOnly\(ctx\.request, endpointUsageId\('locate'\)\)/);
    expect(src).not.toMatch(/countApiUse\(/);
  });
  it('the R2 routes read through the colo cache, as the point lookups do', () => {
    for (const f of ['nearby.ts', 'locate.ts', 'layers/[id]/query.ts', 'layers/[id]/export.ts']) {
      const src = read(`functions/api/v1/${f}`);
      expect(src, f).toMatch(/withColoReads\(/);
      expect(src, f).not.toMatch(/ctx\.env\.R2/);
    }
  });
  it('the binding is declared for production', () => {
    expect(read('wrangler.toml')).toMatch(new RegExp(`\\[\\[analytics_engine_datasets\\]\\]\\s*binding = "API_CALLS"\\s*dataset = "${API_CALLS_DATASET}"`));
  });
});
