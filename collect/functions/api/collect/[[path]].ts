// Catch-all router for /api/collect/v1/*. A single function file keeps the
// (deep) reuse imports in one place and centralises routing + method handling.
// Route → handler mapping mirrors the spec's API table.

import type { Env } from '../../types';
import { bad } from '../../lib/http';
import * as h from '../../lib/handlers';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const method = ctx.request.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  let segs: string[];
  try {
    segs = ((ctx.params.path as string[]) || []).map((s) => decodeURIComponent(s));
  } catch {
    return bad(400, 'bad path');
  }

  if (segs[0] !== 'v1') return bad(404, 'not found');
  const p = segs.slice(1);
  const { env, request } = ctx;

  // /v1/collections
  if (p.length === 1 && p[0] === 'collections') {
    return method === 'POST' ? h.createCollection(env, request) : bad(405, 'method not allowed');
  }

  // /v1/collections/:id[/records|/publish]
  if (p[0] === 'collections' && p[1]) {
    const id = p[1];
    if (p.length === 2) {
      return method === 'GET' ? h.getCollectionMeta(env, request, id) : bad(405, 'method not allowed');
    }
    if (p.length === 3 && p[2] === 'records') {
      if (method === 'GET') return h.listRecords(env, request, id);
      if (method === 'POST') return h.addRecord(env, request, id);
      return bad(405, 'method not allowed');
    }
    if (p.length === 3 && p[2] === 'publish') {
      return method === 'POST' ? h.publish(env, request, id) : bad(405, 'method not allowed');
    }
  }

  // /v1/records/:id/moderate
  if (p[0] === 'records' && p[1] && p[2] === 'moderate' && p.length === 3) {
    return method === 'POST' ? h.moderateRecord(env, request, p[1]) : bad(405, 'method not allowed');
  }

  return bad(404, 'not found');
};
