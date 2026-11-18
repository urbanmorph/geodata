import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { OPENAPI, specPathForRouteFile } from '../functions/lib/openapi';
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
