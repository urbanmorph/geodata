// Batch B of the 2026-11-18 code review: the server's security findings.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { onRequest as apiMiddleware } from '../functions/api/_middleware';
import { ipHashStable } from '../functions/lib/submit-helpers';
import { resolveLocateLayers, MAX_LOCATE_LAYERS } from '../functions/lib/ward-locate';
import { onRequestGet as r2Get } from '../functions/api/r2/[[path]]';
import { MAX_SUBMIT_BYTES } from '../functions/lib/validate-server';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
const run = (req: Request, next = () => Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }))) =>
  apiMiddleware({ request: req, next, env: {}, params: {}, data: {}, waitUntil() {}, passThroughOnException() {}, functionPath: '' } as never);

describe('CORS: other sites may read the API, never write to it', () => {
  it('a preflight for a read is allowed from anywhere', async () => {
    const r = await run(new Request('https://bharatlas.com/api/v1/layers', { method: 'OPTIONS', headers: { origin: 'https://x.example', 'access-control-request-method': 'GET' } }));
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('a preflight for a write gets no CORS grant', async () => {
    const r = await run(new Request('https://bharatlas.com/api/c/abcdefgh/rate', { method: 'OPTIONS', headers: { origin: 'https://x.example', 'access-control-request-method': 'POST' } }));
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('a write from another site is refused before it reaches the handler', async () => {
    let reached = false;
    const r = await run(new Request('https://bharatlas.com/api/c/abcdefgh/rate', { method: 'POST', headers: { origin: 'https://x.example' } }), () => { reached = true; return Promise.resolve(new Response('{}')); });
    expect(r.status).toBe(403);
    expect(reached).toBe(false);
  });
  it('writes from bharatlas itself, or with no Origin (scripts), pass; responses to writes carry no CORS grant', async () => {
    const same = await run(new Request('https://bharatlas.com/api/c/abcdefgh/rate', { method: 'POST', headers: { origin: 'https://bharatlas.com' } }));
    expect(same.status).toBe(200);
    expect(same.headers.get('access-control-allow-origin')).toBeNull();
    expect((await run(new Request('https://bharatlas.com/api/c/abcdefgh/rate', { method: 'POST' }))).status).toBe(200);
  });
  it('reads still carry the grant', async () => {
    const r = await run(new Request('https://bharatlas.com/api/v1/layers', { headers: { origin: 'https://x.example' } }));
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('one vote per IP, not per IP per day', () => {
  it('the vote hash does not change with the date', async () => {
    const req = new Request('https://bharatlas.com/', { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    const a = await ipHashStable(req, 's'); const b = await ipHashStable(req, 's');
    expect(a).toBe(b);
    expect(a).not.toBe(await ipHashStable(req, 't'));
    expect(read('functions/api/c/[id]/rate.ts')).not.toMatch(/ipHashFor\(/);
  });
});

describe('/api/submit: cheap gates before the body is read', () => {
  it('caps uploads at what a Worker can parse', () => {
    expect(MAX_SUBMIT_BYTES).toBe(25 * 1024 * 1024);
  });
  it('refuses an oversized body by its declared length, then checks captcha and rate before reading the file', () => {
    const src = read('functions/api/submit.ts');
    const len = src.indexOf("content-length");
    const form = src.indexOf('request.formData()');
    const gate = src.indexOf('await gateSubmission(');
    const bytes = src.indexOf('await file.arrayBuffer()');
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThan(form);
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(bytes);
  });
});

describe('/api/r2 serves only accepted community uploads', () => {
  const env = (row: unknown) => ({
    DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
    R2: { get: async () => ({ body: 'x', httpEtag: '"e"', writeHttpMetadata() {} }) },
  });
  const get = (e: unknown) => r2Get({ params: { path: ['community', 'abcdefgh12', 'x.geojson'] }, env: e, request: new Request('https://bharatlas.com/api/r2/community/abcdefgh12/x.geojson') } as never);
  it('pending, rejected or withdrawn: 404', async () => {
    expect((await get(env(null))).status).toBe(404);
  });
  it('accepted: served', async () => {
    expect((await get(env({ id: 'abcdefgh12', status: 'accepted' }))).status).toBe(200);
  });
});

describe('locate cannot be made to do unbounded work', () => {
  it('per-layer locate clamps radius and zoom and checks mode', () => {
    const src = read('functions/api/v1/layers/[id]/locate.ts');
    expect(src).toMatch(/clampNum\(url\.searchParams\.get\('radius_km'\)/);
    expect(src).toMatch(/clampNum\(url\.searchParams\.get\('zoom'\)/);
    expect(src).toMatch(/mode must be auto, contains or nearest/);
  });
  it('an explicit layer list is de-duplicated and capped', () => {
    const ids = resolveLocateLayers('lgd_villages,lgd_villages, lgd_states', 77.6, 12.97, []);
    expect(ids).toEqual(['lgd_villages', 'lgd_states']);
    expect(MAX_LOCATE_LAYERS).toBe(25);
    expect(read('functions/api/v1/locate.ts')).toMatch(/layerIds\.length > MAX_LOCATE_LAYERS/);
  });
});
