// bharatlas's hosted MCP server at https://bharatlas.com/mcp: a stateless JSON-RPC
// 2.0 endpoint over Streamable HTTP (MCP 2025-06-18), JSON responses, no sessions.
// It offers the read tools only (mcp/read-tools.js, shared with the npm
// package). Map authoring (collect) needs the share links the npm package keeps on
// the user's machine, so it stays there and no share token ever reaches this server.
//
// Tool calls run the /api/v1 handlers in-process (no fetch back to bharatlas.com)
// and count against the same per-IP limit as the API.

import type { Env } from '../api/_middleware';
import {
  instructionsCore, readToolsFor, readToolRequest, resultText, shapeReadResult, toSearchParams, POINT_PROFILE_TOOLS,
} from '../../../mcp/read-tools.js';
import { apiLimitFor } from './api-ratelimit';
import { json } from './http';
import { onRequestGet as layersIndex } from '../api/v1/layers/index';
import { onRequestGet as layerDetail } from '../api/v1/layers/[id]';
import { onRequestGet as layerSchema } from '../api/v1/layers/[id]/schema';
import { onRequestGet as layerQuery } from '../api/v1/layers/[id]/query';
import { onRequestGet as locate } from '../api/v1/locate';
import { onRequestGet as nearby } from '../api/v1/nearby';
import { onRequestGet as ground } from '../api/v1/ground';
import { onRequestGet as surface } from '../api/v1/surface';
import { onRequestGet as categories } from '../api/v1/categories';
import { onRequestGet as submissions } from '../api/v1/submissions/index';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// The same version as the npm package (mcp/version.test.js holds them equal).
const SERVER_INFO = { name: 'bharatlas', title: "bharatlas: India's open geo data", version: '1.8.0' };
const MAX_BODY = 64 * 1024;

export const instructions = (pointProfiles: boolean) => `bharatlas MCP server (hosted, read-only). India's open geo data: curated layers (state to village boundaries, city wards, forests, hospitals, highways, rivers, canals, groundwater, agro-climatic zones, floods, seismic zones) plus community submissions.

${instructionsCore(pointProfiles)}

Authoring your own maps (collect.bharatlas.com: register a share link, moderate, import, publish) is not on this hosted server. It needs the npm package, which keeps share links on the user's machine: npx -y bharatlas-mcp.`;

// JSON-RPC 2.0 error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version, authorization',
};

type Id = string | number | null;
type WaitUntil = (p: Promise<unknown>) => void;
/** The context an /api/v1 handler needs: the API counts use per layer via waitUntil (lib/usage.ts). */
type Handler = (ctx: { request: Request; env: Env; params: Record<string, string>; waitUntil: WaitUntil }) => Promise<Response> | Response;
/** An /api/v1 path pattern (one capture = the layer id) and its handler. */
export type ApiRoute = [RegExp, Handler];
type RateLimit = (req: Request, tool: string) => Promise<{ ok: true } | { ok: false; retryAfter: number }>;
/** pointProfiles: offer ground_at and surface_at (lib/point-profiles.ts; off unless published). */
export interface McpDeps { routes: ApiRoute[]; rateLimit: RateLimit; waitUntil: WaitUntil; pointProfiles?: boolean }

const asHandler = (h: unknown) => h as Handler;
export const API_ROUTES: ApiRoute[] = [
  [/^\/layers$/, asHandler(layersIndex)],
  [/^\/layers\/([^/]+)$/, asHandler(layerDetail)],
  [/^\/layers\/([^/]+)\/schema$/, asHandler(layerSchema)],
  [/^\/layers\/([^/]+)\/query$/, asHandler(layerQuery)],
  [/^\/locate$/, asHandler(locate)],
  [/^\/nearby$/, asHandler(nearby)],
  [/^\/ground$/, asHandler(ground)],
  [/^\/surface$/, asHandler(surface)],
  [/^\/categories$/, asHandler(categories)],
  [/^\/submissions$/, asHandler(submissions)],
];

/** The API's own per-IP limit, shared with /api/v1 (same keys, same D1 rows, and
 *  the same non-blocking check): 120 calls a minute, locate and ground_at 60 on the locate key. */
export function apiRateLimit(env: Env, waitUntil: WaitUntil): RateLimit {
  return (req, tool) => apiLimitFor(req, env, tool === 'locate' || POINT_PROFILE_TOOLS.has(tool), waitUntil);
}

const ok = (id: Id, result: unknown) => rpc({ jsonrpc: '2.0', id, result });
const err = (id: Id, code: number, message: string) => rpc({ jsonrpc: '2.0', id, error: { code, message } });
function rpc(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}
const toolText = (value: unknown, isError = false) => ({
  content: [{ type: 'text', text: resultText(value) }],
  ...(isError ? { isError: true } : {}),
});

/** 405 for anything but POST and OPTIONS: this server sends no event stream (a GET from an MCP client). */
export const methodNotAllowed = (): Response =>
  new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, OPTIONS', ...CORS } });

/** POST one JSON-RPC request, get one JSON response. */
export async function handleMcp(req: Request, env: Env, deps: McpDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return methodNotAllowed();

  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) {
    return new Response('Payload Too Large', { status: 413, headers: CORS });
  }
  // Bytes, not string length: a 64 KiB string of Devanagari is ~190 KiB.
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BODY) return new Response('Payload Too Large', { status: 413, headers: CORS });
  const raw = new TextDecoder().decode(bytes);

  let msg: { jsonrpc?: string; id?: Id; method?: string; params?: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return err(null, PARSE_ERROR, 'Parse error');
  }
  if (Array.isArray(msg)) return err(null, INVALID_REQUEST, 'Batched requests are not supported');
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return err(msg?.id ?? null, INVALID_REQUEST, 'Invalid Request');
  }

  const { id, method } = msg;
  if (id === undefined) return new Response(null, { status: 202, headers: CORS }); // notification
  // params may be absent or null; anything else must be an object (by name).
  const params = (msg.params ?? {}) as Record<string, unknown>;
  if (typeof params !== 'object' || Array.isArray(params)) return err(id, INVALID_PARAMS, 'params must be an object');

  try {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion as string | undefined;
        return ok(id, {
          protocolVersion: requested && SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: instructions(!!deps.pointProfiles),
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: readToolsFor(!!deps.pointProfiles) });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!readToolsFor(!!deps.pointProfiles).some((t) => t.name === name)) return err(id, INVALID_PARAMS, `Unknown tool: ${name}`);
        if (typeof args !== 'object' || Array.isArray(args)) return err(id, INVALID_PARAMS, 'arguments must be an object');
        return ok(id, await callTool(req, env, deps, name, args));
      }
      default:
        return err(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (e) {
    console.error(`mcp ${method} failed:`, e instanceof Error ? e.stack || e.message : e);
    return err(id, INTERNAL_ERROR, 'Internal error');
  }
}

async function callTool(req: Request, env: Env, deps: McpDeps, name: string, args: Record<string, unknown>) {
  let call: NonNullable<ReturnType<typeof readToolRequest>>;
  try {
    call = readToolRequest(name, args)!;
  } catch (e) {
    return toolText({ error: (e as Error).message }, true);
  }

  const limit = await deps.rateLimit(req, name);
  if (!limit.ok) {
    return toolText({ error: `Rate limit exceeded. Try again in ${limit.retryAfter} s.` }, true);
  }

  try {
    let res = await runRoute(req, env, deps, call.path, toSearchParams(call.params));
    // A retired layer id answers 301 to its successor: follow it once, in-process.
    const moved = res.status === 301 ? res.headers.get('location') : null;
    if (moved) {
      const to = new URL(moved, req.url);
      res = await runRoute(req, env, deps, to.pathname.replace(/^\/api\/v1/, ''), to.searchParams);
    }
    const status = res.status;
    const body = await res.json().catch(() => ({ error: `API ${status}` }));
    if (!res.ok) return toolText({ error: (body as { error?: string }).error || `API ${status}` }, true);
    return toolText(shapeReadResult(name, body));
  } catch (e) {
    console.error(`mcp tool ${name} failed:`, e instanceof Error ? e.stack || e.message : e);
    return toolText({ error: `The ${name} tool failed. Please try again.` }, true);
  }
}

/** Run the /api/v1 handler for `path` in-process (no fetch back to bharatlas.com). */
async function runRoute(req: Request, env: Env, deps: McpDeps, path: string, search: URLSearchParams): Promise<Response> {
  const route = deps.routes.find(([re]) => re.test(path));
  if (!route) return json(404, { error: `No API route for ${path}` });
  const layerId = route[0].exec(path)?.[1];
  const url = new URL(`/api/v1${path}`, req.url);
  url.search = search.toString();
  // The API counts this call as MCP use (usage.ts reads the bharatlas-mcp/ user agent).
  const request = new Request(url, { headers: { accept: 'application/json', 'user-agent': 'bharatlas-mcp/hosted' } });
  // The caller's colo, for the call's speed record (api-calls.ts); a constructed request has no cf of its own.
  const cf = (req as { cf?: unknown }).cf;
  if (cf) Object.defineProperty(request, 'cf', { value: cf });
  return route[1]({
    request,
    env,
    params: layerId ? { id: layerId } : {},
    waitUntil: deps.waitUntil,
  });
}
