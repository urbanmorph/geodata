// The hosted MCP calls the API in-process as 'bharatlas-mcp/hosted', so the API never sees
// the caller's user agent. A caller the site does not count (our test client, a crawler)
// must not be counted or timed through the MCP either.
import { describe, it, expect } from 'vitest';
import { handleMcp, type ApiRoute } from '../functions/lib/mcp';
import { timedCall } from '../functions/lib/api-calls';
import { countApiUse } from '../functions/lib/usage';

function run(userAgent: string) {
  const points: unknown[] = [];
  let usage = 0;
  const waits: Promise<unknown>[] = [];
  const env = {
    API_CALLS: { writeDataPoint: (p: unknown) => points.push(p) },
    DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => { usage++; return []; } },
  };
  // A route that counts and times itself as the real ones do.
  const route = timedCall(async (ctx: { request: Request; env: typeof env; waitUntil(p: Promise<unknown>): void }) => {
    countApiUse(ctx, 'lgd_states');
    return new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } });
  });
  const routes: ApiRoute[] = [[/^\/layers\/([^/]+)\/schema$/, route as never]];
  const req = new Request('https://bharatlas.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent, 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_layer_schema', arguments: { layer_id: 'lgd_states' } } }),
  });
  return handleMcp(req, env as never, { routes, rateLimit: async () => ({ ok: true }), waitUntil: (p) => waits.push(p) })
    .then(async (res) => { await Promise.all(waits); return { status: res.status, points, usage }; });
}

describe('hosted MCP calls are counted by the caller, not by the inner request', () => {
  it('our test client is neither counted nor timed', async () => {
    const r = await run('bharatlas-mcp-test (ops-dashboard owner check)');
    expect(r.status).toBe(200);
    expect(r.points).toEqual([]);
    expect(r.usage).toBe(0);
  });
  it('a crawler is neither counted nor timed', async () => {
    const r = await run('Mozilla/5.0 (compatible; Googlebot/2.1)');
    expect(r.points).toEqual([]);
    expect(r.usage).toBe(0);
  });
  it('a real client is counted and timed, as MCP use', async () => {
    const r = await run('claude-code/2.1.332');
    expect(r.usage).toBe(1);
    expect(r.points).toHaveLength(1);
    expect(JSON.stringify(r.points[0])).toContain('"mcp"');
  });
});
