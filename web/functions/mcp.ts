// POST /mcp: bharatlas's hosted MCP server (lib/mcp.ts). A GET from an MCP client
// (Accept: text/event-stream, asking for a server-sent event stream) gets 405, as the
// Streamable HTTP spec asks of a server that sends none; any other GET falls through to
// the prerendered /mcp page that explains the server.
import type { Env } from './api/_middleware';
import { handleMcp, methodNotAllowed, API_ROUTES, apiRateLimit } from './lib/mcp';
import { pointProfilesOn } from './lib/point-profiles';

const serve: PagesFunction<Env> = (ctx) =>
  handleMcp(ctx.request, ctx.env, {
    routes: API_ROUTES,
    rateLimit: apiRateLimit(ctx.env, (p) => ctx.waitUntil(p)),
    waitUntil: (p) => ctx.waitUntil(p),
    pointProfiles: pointProfilesOn(ctx.env, new URL(ctx.request.url)),
  });

export const onRequestPost = serve;
export const onRequestOptions = serve;
export const onRequestGet: PagesFunction<Env> = (ctx) =>
  (ctx.request.headers.get('accept') ?? '').includes('text/event-stream') ? methodNotAllowed() : ctx.next();
