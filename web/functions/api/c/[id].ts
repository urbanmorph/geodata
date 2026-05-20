// GET /api/c/:id        — public read of submission metadata
// PUT /api/c/:id?key=…  — admin-token-gated edit
// DELETE /api/c/:id?key=… — admin-token-gated retract
//
// Skeleton — full handlers land in checkpoint #29/#30.

import type { Env } from '../_middleware';

type Params = { id: string };

export const onRequestGet: PagesFunction<Env, keyof Params> = async (ctx) => {
  const id = ctx.params.id as string;
  const row = await ctx.env.DB.prepare(
    `SELECT id, created_at, updated_at, status, name, description, category, license,
            attribution, source_url, format, bytes, feature_count, geometry_types, r2_key
     FROM submissions WHERE id = ? AND status = 'accepted'`,
  )
    .bind(id)
    .first();
  if (!row) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(row), { headers: { 'content-type': 'application/json' } });
};

export const onRequestPut: PagesFunction<Env, keyof Params> = async () =>
  new Response(JSON.stringify({ error: 'not implemented' }), { status: 501, headers: { 'content-type': 'application/json' } });

export const onRequestDelete: PagesFunction<Env, keyof Params> = async () =>
  new Response(JSON.stringify({ error: 'not implemented' }), { status: 501, headers: { 'content-type': 'application/json' } });
