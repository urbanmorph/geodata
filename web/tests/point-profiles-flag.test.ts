import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pointProfilesOn } from '../functions/lib/point-profiles';
import { onRequestGet as ground } from '../functions/api/v1/ground';
import { onRequestGet as surface } from '../functions/api/v1/surface';
import { onRequestGet as openapi } from '../functions/api/v1/openapi.json';
import { handleMcp, type ApiRoute } from '../functions/lib/mcp';
// @ts-expect-error plain .mjs
import { gatePointProfiles, POINT_PROFILE_FAQ } from '../scripts/point-profiles.mjs';

// The point lookups are built but unpublished until the release gate passes:
// merging must change nothing public. POINT_PROFILES=on turns them on.

describe('pointProfilesOn', () => {
  it('is off in production unless the env says on; on for a local host unless it says off', () => {
    const prod = new URL('https://bharatlas.com/api/v1/ground');
    const local = new URL('http://localhost:8788/api/v1/ground');
    expect(pointProfilesOn({}, prod)).toBe(false);
    expect(pointProfilesOn(undefined, prod)).toBe(false);
    expect(pointProfilesOn({ POINT_PROFILES: 'on' }, prod)).toBe(true);
    expect(pointProfilesOn({}, local)).toBe(true);
    expect(pointProfilesOn({ POINT_PROFILES: 'off' }, local)).toBe(false);
    expect(pointProfilesOn({}, new URL('https://geodata-3ij.pages.dev/x'))).toBe(false);
  });
});

const call = (handler: typeof ground, url: string, env: Record<string, unknown> = {}) =>
  handler({ request: new Request(url), env, params: {}, waitUntil: () => {} } as never);

describe('the endpoints while the flag is off', () => {
  for (const [name, handler] of [['ground', ground], ['surface', surface]] as const) {
    it(`/api/v1/${name} is a plain 404 in production`, async () => {
      const r = await call(handler, `https://bharatlas.com/api/v1/${name}?lat=28.5&lng=77.1`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: `Not found: /api/v1/${name}`, status: 404 });
    });

    it(`/api/v1/${name} validates input once on (a bad point is a 400, not a 404)`, async () => {
      const r = await call(handler, `https://bharatlas.com/api/v1/${name}?lat=99&lng=77.1`, { POINT_PROFILES: 'on' });
      expect(r.status).toBe(400);
    });
  }
});

describe('openapi.json', () => {
  it('leaves the lookups out while off and lists them when on', async () => {
    const off = await (await call(openapi, 'https://bharatlas.com/api/v1/openapi.json')).json();
    expect(Object.keys(off.paths)).not.toContain('/ground');
    expect(Object.keys(off.paths)).not.toContain('/surface');
    expect(JSON.stringify(off)).not.toMatch(/\/ground|surface_at|ground_at/);
    const on = await (await call(openapi, 'https://bharatlas.com/api/v1/openapi.json', { POINT_PROFILES: 'on' })).json();
    expect(Object.keys(on.paths)).toEqual(expect.arrayContaining(['/ground', '/surface']));
  });
});

describe('the hosted MCP', () => {
  const routes: ApiRoute[] = [[/^\/ground$/, async () => new Response('{}')], [/^\/surface$/, async () => new Response('{}')]];
  const rpc = async (body: unknown, pointProfiles: boolean) => {
    const res = await handleMcp(new Request('https://bharatlas.com/mcp', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      {} as never, { routes, rateLimit: async () => ({ ok: true }), waitUntil: () => {}, pointProfiles });
    return res.json() as Promise<any>;
  };

  it('offers ground_at and surface_at only when on', async () => {
    const off = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, false)).result.tools.map((t: { name: string }) => t.name);
    expect(off).not.toContain('ground_at');
    expect(off).not.toContain('surface_at');
    const on = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, true)).result.tools.map((t: { name: string }) => t.name);
    expect(on).toEqual(expect.arrayContaining(['ground_at', 'surface_at']));
  });

  it('refuses a call to ground_at while off, as an unknown tool', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ground_at', arguments: { lat: 1, lng: 2 } } }, false);
    expect(r.error?.message ?? r.result?.content?.[0]?.text).toMatch(/Unknown tool/i);
  });

  it('says nothing about the lookups in its instructions while off', async () => {
    const off = (await rpc({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }, false)).result.instructions;
    expect(off).not.toMatch(/ground_at|surface_at/);
    const on = (await rpc({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }, true)).result.instructions;
    expect(on).toMatch(/ground_at/);
    expect(on).toMatch(/surface_at/);
  });
});

describe('the build-time copy', () => {
  it('drops the marked blocks while off and keeps their contents (without the marks) when on', () => {
    const html = 'a\n<!-- point-profiles -->\nsecret\n<!-- /point-profiles -->\nb';
    expect(gatePointProfiles(html, false)).toBe('a\nb');
    expect(gatePointProfiles(html, true)).toBe('a\nsecret\nb');
  });

  it('marks every mention of the lookups in the docs template, and in nothing else that ships', () => {
    const docs = readFileSync(new URL('../docs.template.html', import.meta.url), 'utf8');
    expect(gatePointProfiles(docs, false)).not.toMatch(/\/ground|\/surface|ground_at|surface_at/);
    expect(gatePointProfiles(docs, true)).toMatch(/\/api\/v1\/ground/);
    for (const f of ['../public/llms.txt', '../mcp.template.html', '../public/.well-known/mcp.json']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8'), f).not.toMatch(/ground_at|surface_at|\/api\/v1\/ground/);
    }
    expect(POINT_PROFILE_FAQ.length).toBe(2);
  });
});
