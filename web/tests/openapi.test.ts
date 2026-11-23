import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { specPathForRouteFile } from '../functions/lib/openapi';
import { OPENAPI } from '../functions/lib/lookups';
import { QUERY_OPTIONS } from '../functions/lib/query-params';
import { onRequestGet } from '../functions/api/v1/openapi.json';

const V1 = resolve(dirname(fileURLToPath(import.meta.url)), '../functions/api/v1');

/** Every handler file under functions/api/v1, relative to it. */
function routeFiles(dir = V1): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    if (!name.endsWith('.ts') || name === '_middleware.ts' || name === 'openapi.json.ts') return [];
    return [relative(V1, full)];
  });
}

type Param = { name: string; in: string };
/** A path's parameters, with `$ref`s to components/parameters resolved. */
const paramsOf = (path: string): Param[] =>
  ((OPENAPI.paths as any)[path].get.parameters ?? []).map((p: any) =>
    p.$ref ? (OPENAPI.components.parameters as any)[p.$ref.split('/').pop()] : p);

describe('specPathForRouteFile', () => {
  it('maps file-system routes to OpenAPI paths', () => {
    expect(specPathForRouteFile('locate.ts')).toBe('/locate');
    expect(specPathForRouteFile('layers/index.ts')).toBe('/layers');
    expect(specPathForRouteFile('layers/[id].ts')).toBe('/layers/{id}');
    expect(specPathForRouteFile('layers/[id]/query.ts')).toBe('/layers/{id}/query');
    expect(specPathForRouteFile('downloads/counts.ts')).toBe('/downloads/counts');
  });
});

describe('the OpenAPI description', () => {
  it('asks for a User-Agent only to sort calls by mode, with no promise to contact the caller', () => {
    const d = OPENAPI.info.description;
    expect(d).toContain('Please send a `User-Agent` that names your app (for example `my-app/1.0`).');
    expect(d).toContain("We don't store it, and we don't track who you are.");
    expect(d).not.toMatch(/tell you before a change/);
  });

  it('llms.txt says MCP calls are counted per layer, not by caller', () => {
    const llms = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../public/llms.txt'), 'utf8');
    expect(llms).toContain('We count MCP calls per layer, and keep nothing about the caller.');
    expect(llms).not.toMatch(/count calls by app/);
  });

  it('is OpenAPI 3.1 for the v1 base URL', () => {
    expect(OPENAPI.openapi).toBe('3.1.0');
    expect(OPENAPI.servers[0].url).toBe('https://bharatlas.com/api/v1');
  });

  it('describes every route file under functions/api/v1 (a new route without a spec entry fails here)', () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      expect(Object.keys(OPENAPI.paths), f).toContain(specPathForRouteFile(f));
    }
  });

  it('describes no route that does not exist', () => {
    const real = new Set(routeFiles().map(specPathForRouteFile));
    for (const p of Object.keys(OPENAPI.paths)) expect(real.has(p), p).toBe(true);
  });

  it('lists every query parameter each handler reads', () => {
    for (const f of routeFiles()) {
      const src = readFileSync(join(V1, f), 'utf8');
      const read = [...src.matchAll(/searchParams\.get\('([a-z_]+)'\)/g)].map((m) => m[1]);
      const declared = paramsOf(specPathForRouteFile(f)).filter((p) => p.in === 'query').map((p) => p.name);
      for (const name of read) expect(declared, `${f} reads ?${name}`).toContain(name);
    }
  });

  it('lists every reserved option of /layers/{id}/query', () => {
    const declared = paramsOf('/layers/{id}/query').map((p) => p.name);
    for (const name of QUERY_OPTIONS) expect(declared, name).toContain(name);
  });

  it('declares the {id} path parameter wherever the path has one', () => {
    for (const path of Object.keys(OPENAPI.paths).filter((p) => p.includes('{id}'))) {
      expect(paramsOf(path).some((p) => p.name === 'id' && p.in === 'path'), path).toBe(true);
    }
  });

  it('gives every operation an operationId, a summary and a 200 response', () => {
    const ids = new Set<string>();
    for (const [path, item] of Object.entries(OPENAPI.paths as Record<string, any>)) {
      const op = item.get;
      expect(op.operationId, path).toBeTruthy();
      expect(op.summary, path).toBeTruthy();
      expect(op.responses['200'], path).toBeTruthy();
      expect(ids.has(op.operationId), op.operationId).toBe(false);
      ids.add(op.operationId);
    }
  });

  it('resolves every $ref it uses', () => {
    const refs = [...JSON.stringify(OPENAPI).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const [ref, kind, name] of refs) {
      expect((OPENAPI.components as any)[kind]?.[name], ref).toBeTruthy();
    }
  });
});

describe('a layer names its citable versions (spec-data-lifecycle 8.4)', () => {
  it('the Layer schema documents `versions`, each with the fields /layers/{id} returns', () => {
    const v = (OPENAPI.components.schemas as any).Layer.properties.versions;
    expect(v.type).toBe('array');
    expect(Object.keys(v.items.properties).sort()).toEqual(['code', 'released', 'sha256', 'url', 'w3id']);
    expect(v.description).toMatch(/newest first/);
  });
});

// Lookup filters (2026-11-23): realm and lookups on layers; sections and layers on the lookups.
describe('realms and lookup filters', () => {
  const S = OPENAPI.components.schemas as any;
  const P = OPENAPI.paths as any;
  const param = (path: string, name: string) => paramsOf(path).find((p) => p.name === name) as any;
  it('the Layer schema says realm and lookups', () => {
    expect(S.Layer.properties.realm.enum).toEqual(['below', 'ground', 'air']);
    expect(S.Layer.properties.lookups.properties).toEqual({ ground: expect.any(Object), surface: expect.any(Object) });
  });
  it('/layers takes realm and can answer 400', () => {
    expect(param('/layers', 'realm').schema.enum).toEqual(['below', 'ground', 'air']);
    expect(P['/layers'].get.responses['400']).toBeTruthy();
  });
  it('/ground and /surface take sections (their own) and layers, listing each section\'s layers and the rasters', () => {
    expect(param('/ground', 'sections').schema.items.enum).toEqual(['seismic', 'geology', 'resources', 'groundwater', 'soil', 'subsidence', 'underground', 'watershed']);
    expect(param('/surface', 'sections').schema.items.enum).toEqual(['place', 'land', 'climate', 'water', 'hazards', 'protected', 'access', 'services', 'infrastructure']);
    expect(param('/ground', 'layers').description).toMatch(/soil: soilgrids \(raster\), slusi_soil_health/);
    expect(param('/surface', 'layers').description).toMatch(/land: worldcover \(raster\), dem \(raster\), worldpop \(raster\), corestack_lulc_blocks/);
    expect(param('/surface', 'layers').description).toMatch(/ward layer/);
    expect(S.GroundResult.properties.filter).toBeTruthy();
  });
});

describe('matches the handlers after the 2026-11-19 review', () => {
  const S = OPENAPI.components.schemas as any;
  const P = OPENAPI.paths as any;
  it('LocateResult carries zoom, failed_layers and unknown_layers', () => {
    expect(Object.keys(S.LocateResult.properties)).toEqual(expect.arrayContaining(['zoom', 'failed_layers', 'unknown_layers']));
  });
  it('/locate can answer 500; /usage and /downloads/counts 429 and 503; /usage 404', () => {
    expect(Object.keys(P['/locate'].get.responses)).toContain('500');
    for (const path of ['/usage', '/downloads/counts']) {
      expect(Object.keys(P[path].get.responses), path).toEqual(expect.arrayContaining(['429', '503']));
    }
    expect(Object.keys(P['/usage'].get.responses)).toContain('404');
  });
  it('documents the 301 for a retired layer id', () => {
    expect(JSON.stringify(P['/layers/{id}'].get.responses)).toMatch(/301/);
    expect(OPENAPI.components.responses).toHaveProperty('MovedPermanently');
  });
  it('/layers?q searches category, level and tags too', () => {
    const qp = P['/layers'].get.parameters.find((p: any) => p.name === 'q');
    expect(qp.description).toMatch(/category.*level.*tags/);
  });
  it('/query says unknown select, where and filter columns are a 400', () => {
    expect(P['/layers/{id}/query'].get.description).toMatch(/unknown column.*400/i);
  });
  it('w3id is described as live, not pending registration', () => {
    expect(JSON.stringify(OPENAPI)).not.toMatch(/once registered/);
    expect(S.ReleaseIndex.properties.releases.items.properties.w3id_proposed.description).toMatch(/w3id\.org\/bharatlas/);
  });
});

describe('GET /api/v1/openapi.json', () => {
  it('serves the description as JSON (CORS and x-api-version come from the api middlewares)', async () => {
    const res = await (onRequestGet as any)({ request: new Request('https://bharatlas.com/api/v1/openapi.json') });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.openapi).toBe('3.1.0');
    expect(Object.keys(body.paths)).toContain('/locate');
  });
});
