// POST /mcp: bharatlas's hosted MCP server (lib/mcp.ts). GET has no handler here,
// so it falls through to the prerendered /mcp page that explains the server.
import type { Env } from './api/_middleware';
import { handleMcp, API_ROUTES, apiRateLimit } from './lib/mcp';

const serve: PagesFunction<Env> = (ctx) =>
  handleMcp(ctx.request, ctx.env, { routes: API_ROUTES, rateLimit: apiRateLimit(ctx.env) });

export const onRequestPost = serve;
export const onRequestOptions = serve;
