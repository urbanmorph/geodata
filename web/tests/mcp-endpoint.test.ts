import { describe, it, expect } from 'vitest';
import { handleMcp, type ApiRoute, type McpDeps } from '../functions/lib/mcp';
import { READ_TOOLS, readToolRequest } from '../../mcp/read-tools.js';

const ORIGIN = 'https://bharatlas.com';

type Seen = { url: URL; params: Record<string, string> };

/** Stub API routes: each records what it was called with and answers `body`. */
function stubRoutes(body: unknown = { data: [] }, status = 200) {
  const seen: Seen[] = [];
  const handler = async (ctx: { request: Request; params: Record<string, string> }) => {
    seen.push({ url: new URL(ctx.request.url), params: ctx.params });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const routes: ApiRoute[] = [
    [/^\/layers$/, handler],
    [/^\/layers\/([^/]+)$/, handler],
    [/^\/layers\/([^/]+)\/schema$/, handler],
    [/^\/layers\/([^/]+)\/query$/, handler],
    [/^\/locate$/, handler],
    [/^\/nearby$/, handler],
    [/^\/categories$/, handler],
    [/^\/submissions$/, handler],
  ];
  return { routes, seen };
}

const allow = async () => ({ ok: true as const });

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

type Json = any; // JSON-RPC replies, checked field by field

async function rpc(body: unknown, opts: { routes?: ApiRoute[]; rateLimit?: McpDeps['rateLimit'] } = {}) {
  const res = await handleMcp(post(body), {} as never, {
    routes: opts.routes ?? stubRoutes().routes,
    rateLimit: opts.rateLimit ?? allow,
  });
  const json: Json = res.status === 200 ? await res.json() : null;
  return { res, json };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args },
});

describe('/mcp protocol', () => {
  it('initialize names the server, offers tools and echoes a supported protocol version', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(json.result.protocolVersion).toBe('2025-03-26');
    expect(json.result.serverInfo.name).toBe('bharatlas');
    expect(json.result.capabilities).toEqual({ tools: {} });
    expect(json.result.instructions).toContain('get_layer_schema BEFORE query_layer');
    expect(json.result.instructions).not.toContain('register_map');
  });

  it('initialize falls back to its own version for an unknown one', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(json.result.protocolVersion).toBe('2025-06-18');
  });

  it('tools/list offers exactly the eight read tools, all marked read-only', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      'list_layers', 'get_layer_schema', 'query_layer', 'locate',
      'nearby', 'list_categories', 'get_layer_detail', 'list_submissions',
    ]);
    for (const t of json.result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.description.length).toBeGreaterThan(20);
      for (const p of Object.values(t.inputSchema.properties ?? {}) as { description?: string }[]) {
        expect(p.description, `${t.name} argument description`).toBeTruthy();
      }
    }
  });

  it('ping answers an empty result', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' });
    expect(json).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  it('a notification is acknowledged with 202 and no body', async () => {
    const { res } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('bad JSON is a parse error', async () => {
    const { json } = await rpc('{not json');
    expect(json.error.code).toBe(-32700);
  });

  it('batches and malformed requests are rejected', async () => {
    expect((await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).json.error.code).toBe(-32600);
    expect((await rpc({ id: 1, method: 'ping' })).json.error.code).toBe(-32600);
  });

  it('an unknown method is method-not-found', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    expect(json.error.code).toBe(-32601);
  });

  it('an oversized body is refused before parsing', async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } });
    const { res } = await rpc(big);
    expect(res.status).toBe(413);
  });

  it('answers OPTIONS with CORS headers', async () => {
    const res = await handleMcp(new Request(`${ORIGIN}/mcp`, { method: 'OPTIONS' }), {} as never, { routes: [], rateLimit: allow });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('/mcp tools/call', () => {
  it('list_layers calls the layers API and returns the compact list', async () => {
    const { routes, seen } = stubRoutes({
      data: [{ id: 'lgd_states', level: 'state', source: 'LGD', category: 'boundaries', rows: 36, licence: 'GODL', notes: '', downloads: { parquet: 'x' } }],
      total: 1,
    });
    const { json } = await rpc(call('list_layers', { q: 'state' }), { routes });
    expect(seen[0].url.pathname).toBe('/api/v1/layers');
    expect(seen[0].url.searchParams.get('q')).toBe('state');
    expect(seen[0].url.searchParams.get('limit')).toBe('20');
    const out = JSON.parse(json.result.content[0].text);
    expect(out.data[0]).toEqual({ id: 'lgd_states', level: 'state', source: 'LGD', category: 'boundaries', rows: 36, licence: 'GODL', notes: '' });
    expect(json.result.isError).toBeUndefined();
  });

  it('query_layer passes the layer id as a route param and each filter as its own query param', async () => {
    const { routes, seen } = stubRoutes({ data: [] });
    await rpc(call('query_layer', { layer_id: 'airports', where: { state: 'KA', limit: '5' }, select: ['name', 'iata'] }), { routes });
    expect(seen[0].url.pathname).toBe('/api/v1/layers/airports/query');
    expect(seen[0].params).toEqual({ id: 'airports' });
    expect(seen[0].url.searchParams.get('state')).toBe('KA');
    expect(seen[0].url.searchParams.get('select')).toBe('name,iata');
    expect(seen[0].url.searchParams.get('where')).toBe('limit=5');
  });

  it('locate joins explicit layers and keeps lat/lng', async () => {
    const { routes, seen } = stubRoutes({ data: {} });
    await rpc(call('locate', { lat: 12.97, lng: 77.59, layers: ['lgd_states', 'lgd_districts'] }), { routes });
    expect(seen[0].url.pathname).toBe('/api/v1/locate');
    expect(seen[0].url.searchParams.get('lat')).toBe('12.97');
    expect(seen[0].url.searchParams.get('layers')).toBe('lgd_states,lgd_districts');
  });

  it('an API error comes back as a tool error with the API message', async () => {
    const { routes } = stubRoutes({ error: 'Layer not found', status: 404 }, 404);
    const { json } = await rpc(call('get_layer_detail', { layer_id: 'nope' }), { routes });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain('Layer not found');
  });

  it('a layer id that is not a plain id never reaches the API', async () => {
    const { routes, seen } = stubRoutes();
    const { json } = await rpc(call('get_layer_schema', { layer_id: '../submissions' }), { routes });
    expect(seen).toHaveLength(0);
    expect(json.result.isError).toBe(true);
  });

  it('collect tools are not offered: unknown tool is invalid params', async () => {
    const { json } = await rpc(call('register_map', { link: 'https://collect.bharatlas.com/c/x#adm_y' }));
    expect(json.error.code).toBe(-32602);
  });

  it('is rate limited per caller IP, with locate on its own tighter limit', async () => {
    const asked: { ip: string; tool: string }[] = [];
    const deny = async (ip: string, tool: string) => { asked.push({ ip, tool }); return { ok: false as const, retryAfter: 12 }; };
    const { routes, seen } = stubRoutes();
    const { json } = await rpc(call('locate', { lat: 12.9, lng: 77.5 }), { routes, rateLimit: deny });
    expect(asked).toEqual([{ ip: '203.0.113.9', tool: 'locate' }]);
    expect(seen).toHaveLength(0);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain('12');
  });
});

describe('read-tools (shared with the npm package)', () => {
  it('maps every read tool to an API request', () => {
    for (const t of READ_TOOLS) {
      const args: Record<string, unknown> = { layer_id: 'lgd_states', lat: 12.9, lng: 77.5 };
      expect(readToolRequest(t.name, args), t.name).not.toBeNull();
    }
    expect(readToolRequest('publish', {})).toBeNull();
  });
});
