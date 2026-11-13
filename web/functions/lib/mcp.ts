// bharatlas's hosted MCP server at https://bharatlas.com/mcp: a stateless JSON-RPC
// 2.0 endpoint over Streamable HTTP (MCP 2025-06-18), JSON responses, no sessions.
// It offers the eight read tools only (mcp/read-tools.js, shared with the npm
// package). Map authoring (collect) needs the share links the npm package keeps on
// the user's machine, so it stays there and no share token ever reaches this server.
//
// Tool calls run the /api/v1 handlers in-process (no fetch back to bharatlas.com)
// and count against the same per-IP limit as the API.

import type { Env } from '../api/_middleware';
import {
  INSTRUCTIONS_CORE, READ_TOOLS, readToolRequest, shapeReadResult, toSearchParams,
} from '../../../mcp/read-tools.js';
import { checkApiRateLimit } from './api-ratelimit';
import { sha256Hex } from './submit-helpers';
import { onRequestGet as layersIndex } from '../api/v1/layers/index';
import { onRequestGet as layerDetail } from '../api/v1/layers/[id]';
import { onRequestGet as layerSchema } from '../api/v1/layers/[id]/schema';
import { onRequestGet as layerQuery } from '../api/v1/layers/[id]/query';
import { onRequestGet as locate } from '../api/v1/locate';
import { onRequestGet as nearby } from '../api/v1/nearby';
import { onRequestGet as categories } from '../api/v1/categories';
import { onRequestGet as submissions } from '../api/v1/submissions/index';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'bharatlas', title: "bharatlas: India's open geo data", version: '1.4.0' };
const MAX_BODY = 64 * 1024;

export const INSTRUCTIONS = `bharatlas MCP server (hosted, read-only). India's open geo data: curated layers (state to village boundaries, city wards, forests, hospitals, highways, rivers, canals, groundwater, agro-climatic zones, floods, seismic zones) plus community submissions.

${INSTRUCTIONS_CORE}

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
type Handler = (ctx: { request: Request; env: Env; params: Record<string, string> }) => Promise<Response> | Response;
/** An /api/v1 path pattern (one capture = the layer id) and its handler. */
export type ApiRoute = [RegExp, Handler];
type RateLimit = (ip: string, tool: string) => Promise<{ ok: true } | { ok: false; retryAfter: number }>;
export interface McpDeps { routes: ApiRoute[]; rateLimit: RateLimit }

const asHandler = (h: unknown) => h as Handler;
export const API_ROUTES: ApiRoute[] = [
  [/^\/layers$/, asHandler(layersIndex)],
  [/^\/layers\/([^/]+)$/, asHandler(layerDetail)],
  [/^\/layers\/([^/]+)\/schema$/, asHandler(layerSchema)],
  [/^\/layers\/([^/]+)\/query$/, asHandler(layerQuery)],
  [/^\/locate$/, asHandler(locate)],
  [/^\/nearby$/, asHandler(nearby)],
  [/^\/categories$/, asHandler(categories)],
  [/^\/submissions$/, asHandler(submissions)],
];

/** The API's own per-IP limit (D1), shared with /api/v1: 120 calls a minute, locate 60. */
export function apiRateLimit(env: Env): RateLimit {
  return async (ip, tool) => {
    try {
      return await checkApiRateLimit(env.DB, await sha256Hex(new TextEncoder().encode(ip).buffer as ArrayBuffer), tool === 'locate' ? 60 : 120);
    } catch {
      return { ok: true }; // a D1 failure should not block reads (as in /api/v1)
    }
  };
}

const ok = (id: Id, result: unknown) => rpc({ jsonrpc: '2.0', id, result });
const err = (id: Id, code: number, message: string) => rpc({ jsonrpc: '2.0', id, error: { code, message } });
function rpc(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
  });
}
const toolText = (value: unknown, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) }],
  ...(isError ? { isError: true } : {}),
});

/** POST one JSON-RPC request, get one JSON response. */
export async function handleMcp(req: Request, env: Env, deps: McpDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, OPTIONS', ...CORS } });
  }

  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) {
    return new Response('Payload Too Large', { status: 413, headers: CORS });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return new Response('Payload Too Large', { status: 413, headers: CORS });

  let msg: { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw);
  } catch {
    return err(null, PARSE_ERROR, 'Parse error');
  }
  if (Array.isArray(msg)) return err(null, INVALID_REQUEST, 'Batched requests are not supported');
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return err(msg?.id ?? null, INVALID_REQUEST, 'Invalid Request');
  }

  const { id, method, params = {} } = msg;
  if (id === undefined) return new Response(null, { status: 202, headers: CORS }); // notification

  try {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion as string | undefined;
        return ok(id, {
          protocolVersion: requested && SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: READ_TOOLS });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments as Record<string, unknown>) ?? {};
        if (!READ_TOOLS.some((t) => t.name === name)) return err(id, INVALID_PARAMS, `Unknown tool: ${name}`);
        return ok(id, await callTool(req, env, deps, name, args));
      }
      default:
        return err(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch {
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

  const limit = await deps.rateLimit(req.headers.get('cf-connecting-ip') || 'unknown', name);
  if (!limit.ok) {
    return toolText({ error: `Rate limit exceeded. Try again in ${limit.retryAfter} s.` }, true);
  }

  const route = deps.routes.find(([re]) => re.test(call.path));
  if (!route) return toolText({ error: `No API route for ${call.path}` }, true);
  const layerId = route[0].exec(call.path)?.[1];

  const url = new URL(`/api/v1${call.path}`, req.url);
  url.search = toSearchParams(call.params).toString();
  try {
    const res = await route[1]({
      request: new Request(url, { headers: { accept: 'application/json' } }),
      env,
      params: layerId ? { id: layerId } : {},
    });
    const body = await res.json().catch(() => ({ error: `API ${res.status}` }));
    if (!res.ok) return toolText({ error: (body as { error?: string }).error || `API ${res.status}` }, true);
    return toolText(shapeReadResult(name, body));
  } catch (e) {
    return toolText({ error: `The ${name} tool failed: ${(e as Error).message}` }, true);
  }
}
