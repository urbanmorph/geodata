// Handler functions for the collect API. The catch-all router ([[path]].ts)
// parses the route and calls these. Each returns a Response.
//
// Phase 1 scope: create → contribute → (moderate) → publish, plus scoped reads.
// Enrichment (admin_ctx) is Phase 4 → stored null here. Edit/delete/de-identify
// endpoints are Phase 3.

import type { Env } from '../types';
import { bad, json } from './http';
import { generateToken, tokenPrefix, hashToken, generateRecordToken } from './tokens';
import { bearer, permissionFor, atLeast } from './auth';
import { checkCreateRate, checkRecordRate } from './ratelimit';
import { logCollectAttempt } from './collect-log';
import { nanoid, sha256Hex, ipHashFor, verifyTurnstile, insertSubmission, insertToken } from './reuse';
import * as db from './db';
import { validateNewCollection } from '../../src/schema/validate-collection';
import { validateRecordProperties, type Field } from '../../src/schema/validate-record';
import { checkIndiaBounds } from '../../src/geo/bounds';
import { composeAttribution } from '../../src/publish/attribution';

const BHARATLAS_ORIGIN = 'https://bharatlas.com';

const salt = (env: Env) => env.IP_SALT || 'collect-v1';

// Turnstile: verify when a secret is configured (prod); skip in local dev.
async function turnstileOk(env: Env, token: unknown): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  return typeof token === 'string' && (await verifyTurnstile(token, env.TURNSTILE_SECRET));
}

function geomBucket(type: string): 'point' | 'line' | 'polygon' | null {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'LineString' || type === 'MultiLineString') return 'line';
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon';
  return null;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---- POST /collections -----------------------------------------------------

export async function createCollection(env: Env, req: Request): Promise<Response> {
  const ipHash = await ipHashFor(req, salt(env));
  const body = await readJson(req);
  if (!body) return bad(400, 'invalid JSON body');

  if (!(await turnstileOk(env, body.turnstile_token))) {
    void logCollectAttempt(env.DB, { event: 'create', outcome: 'rejected', gate: 'captcha', ip_hash: ipHash });
    return bad(403, 'captcha failed');
  }
  if (!(await checkCreateRate(env.DB, ipHash))) {
    void logCollectAttempt(env.DB, { event: 'create', outcome: 'rejected', gate: 'rateLimit', ip_hash: ipHash });
    return bad(429, 'rate limit: 5 collections per day');
  }

  const v = validateNewCollection(body);
  if (!v.ok) {
    void logCollectAttempt(env.DB, { event: 'create', outcome: 'rejected', gate: 'schema', reason: v.error, ip_hash: ipHash });
    return bad(400, v.error);
  }

  const moderation = body.moderation === 0 || body.moderation === false ? 0 : 1;
  const id = nanoid(10);
  await db.createCollection(env.DB, { id, ...v.value, moderation, ip_hash: ipHash });

  const tokens = { admin: generateToken('admin'), edit: generateToken('edit'), view: generateToken('view') } as const;
  for (const [perm, tok] of Object.entries(tokens)) {
    await db.addCollectionToken(env.DB, {
      collectionId: id,
      prefix: tokenPrefix(tok),
      hash: await hashToken(tok),
      permission: perm as 'admin' | 'edit' | 'view',
    });
  }

  void logCollectAttempt(env.DB, { event: 'create', outcome: 'ok', collection_id: id, ip_hash: ipHash });
  const origin = new URL(req.url).origin;
  return json(200, {
    id,
    links: {
      edit: `${origin}/c/${id}#${tokens.edit}`,
      admin: `${origin}/c/${id}/admin#${tokens.admin}`,
      view: `${origin}/c/${id}/view#${tokens.view}`,
    },
    tokens, // shown once
  });
}

// ---- GET /collections/:id --------------------------------------------------

export async function getCollectionMeta(env: Env, req: Request, id: string): Promise<Response> {
  const perm = await permissionFor(env.DB, id, bearer(req));
  if (!perm) return bad(401, 'unauthorised');
  const c = await db.getCollection(env.DB, id);
  if (!c) return bad(404, 'not found');
  const counts = await db.statusCounts(env.DB, id);
  return json(200, {
    id: c.id,
    name: c.name,
    description: c.description,
    purpose: c.purpose,
    license: c.license,
    data_year: c.data_year,
    status: c.status,
    moderation: c.moderation,
    schema: JSON.parse(c.schema_doc),
    counts,
  });
}

// ---- GET /collections/:id/records ------------------------------------------

export async function listRecords(env: Env, req: Request, id: string): Promise<Response> {
  const perm = await permissionFor(env.DB, id, bearer(req));
  if (!perm) return bad(401, 'unauthorised');

  const url = new URL(req.url);
  const wanted = url.searchParams.get('status') || '';
  // Read scope: only admin may see pending/rejected; others get published only.
  let status: string | undefined = 'published';
  if (atLeast(perm, 'admin')) status = wanted || undefined;
  else if (wanted && wanted !== 'published') return bad(403, 'only admin can read un-moderated records');

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 1), 2000);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  const rows = await db.listRecords(env.DB, id, { status, limit, offset });

  const features = rows.map((r) => ({
    type: 'Feature' as const,
    id: r.id,
    geometry: JSON.parse(r.geometry),
    properties: {
      ...JSON.parse(r.properties),
      _status: r.status,
      _contributor: r.contributor,
      _created_at: r.created_at,
    },
  }));
  return json(200, { type: 'FeatureCollection', features });
}

// ---- POST /collections/:id/records -----------------------------------------

export async function addRecord(env: Env, req: Request, id: string): Promise<Response> {
  const ipHash = await ipHashFor(req, salt(env));
  const perm = await permissionFor(env.DB, id, bearer(req));
  if (!atLeast(perm, 'edit')) return bad(401, 'unauthorised — need the edit or admin link');

  const c = await db.getCollection(env.DB, id);
  if (!c) return bad(404, 'not found');
  if (c.status === 'closed') return bad(403, 'this collection is closed to new records');

  const body = await readJson(req);
  if (!body) return bad(400, 'invalid JSON body');

  if (!(await turnstileOk(env, body.turnstile_token))) {
    void logCollectAttempt(env.DB, { event: 'contribute', outcome: 'rejected', gate: 'captcha', collection_id: id, ip_hash: ipHash });
    return bad(403, 'captcha failed');
  }
  if (!(await checkRecordRate(env.DB, ipHash))) {
    void logCollectAttempt(env.DB, { event: 'contribute', outcome: 'rejected', gate: 'rateLimit', collection_id: id, ip_hash: ipHash });
    return bad(429, 'rate limit: 200 records per hour');
  }

  const geometry = body.geometry;
  const bounds = checkIndiaBounds(geometry);
  if (!bounds.ok) {
    void logCollectAttempt(env.DB, { event: 'contribute', outcome: 'rejected', gate: 'bounds', reason: bounds.error, collection_id: id, ip_hash: ipHash });
    return bad(400, bounds.error);
  }

  const schema = JSON.parse(c.schema_doc) as { geometry: string[]; fields: Field[] };
  const bucket = geomBucket((geometry as { type: string }).type);
  if (!bucket || !schema.geometry.includes(bucket)) {
    return bad(400, `this collection accepts ${schema.geometry.join(', ')} geometry`);
  }

  const validated = validateRecordProperties(schema.fields, body.properties);
  if (!validated.ok) {
    void logCollectAttempt(env.DB, { event: 'contribute', outcome: 'rejected', gate: 'schema', reason: validated.error, collection_id: id, ip_hash: ipHash });
    return bad(400, validated.error);
  }

  const contributor = typeof body.contributor === 'string' && body.contributor.trim() !== '' ? body.contributor.trim() : null;
  const status: 'pending' | 'published' = c.moderation ? 'pending' : 'published';
  const recId = nanoid(10);
  const recToken = generateRecordToken();

  await db.insertRecord(env.DB, {
    id: recId,
    collectionId: id,
    status,
    geometry: JSON.stringify(geometry),
    properties: JSON.stringify(validated.properties),
    admin_ctx: null, // enrichment is Phase 4
    contributor,
    edit_token_hash: await hashToken(recToken),
    ip_hash: ipHash,
  });
  await db.touchCollection(env.DB, id);

  void logCollectAttempt(env.DB, { event: 'contribute', outcome: 'ok', collection_id: id, ip_hash: ipHash });
  return json(200, { id: recId, status, edit_token: recToken });
}

// ---- POST /records/:id/moderate --------------------------------------------

export async function moderateRecord(env: Env, req: Request, recordId: string): Promise<Response> {
  const rec = await db.getRecord(env.DB, recordId);
  if (!rec) return bad(404, 'not found');
  const perm = await permissionFor(env.DB, rec.collection_id, bearer(req));
  if (!atLeast(perm, 'admin')) return bad(401, 'unauthorised');

  const body = await readJson(req);
  const status = body?.status;
  if (status !== 'published' && status !== 'rejected' && status !== 'pending') {
    return bad(400, 'status must be published, rejected, or pending');
  }
  const reason = typeof body?.reason === 'string' ? body.reason : null;
  await db.setRecordStatus(env.DB, recordId, status, reason);
  return json(200, { id: recordId, status });
}

// ---- POST /collections/:id/publish -----------------------------------------

export async function publish(env: Env, req: Request, id: string): Promise<Response> {
  const perm = await permissionFor(env.DB, id, bearer(req));
  if (!atLeast(perm, 'admin')) return bad(401, 'unauthorised');

  const c = await db.getCollection(env.DB, id);
  if (!c) return bad(404, 'not found');

  const rows = await db.listRecords(env.DB, id, { status: 'published', limit: 100000, offset: 0 });
  if (rows.length === 0) {
    void logCollectAttempt(env.DB, { event: 'publish', outcome: 'rejected', gate: 'empty', collection_id: id });
    return bad(409, 'nothing approved to publish yet');
  }

  const features = rows.map((r) => ({
    type: 'Feature' as const,
    geometry: JSON.parse(r.geometry),
    properties: JSON.parse(r.properties),
  }));
  const fc = { type: 'FeatureCollection', features };
  const bytes = new TextEncoder().encode(JSON.stringify(fc));
  const contentHash = await sha256Hex(bytes.buffer);

  // R6: refuse a republish with byte-identical content ("nothing new since v{N}").
  const version = await db.nextVersion(env.DB, id);
  if (version > 1) {
    const prev = (await env.DB
      .prepare(`SELECT content_hash FROM publications WHERE collection_id = ? AND version = ?`)
      .bind(id, version - 1)
      .first()) as { content_hash: string } | null;
    if (prev?.content_hash === contentHash) return bad(409, `nothing new since v${version - 1}`);
  }

  const attribution = composeAttribution(c.name, c.license, rows.map((r) => r.contributor));
  const geomTypes = [...new Set(rows.map((r) => (JSON.parse(r.geometry) as { type: string }).type))].join(',');

  const submissionId = nanoid(10);
  const r2Key = `community/${submissionId}/${submissionId}.geojson`;
  const contributorsKey = `community/${submissionId}/contributors.json`;
  const adminToken = generateToken('admin');

  await env.R2.put(r2Key, bytes, {
    httpMetadata: { contentType: 'application/geo+json', contentDisposition: `attachment; filename="${submissionId}.geojson"` },
  });
  await env.R2.put(
    contributorsKey,
    JSON.stringify({
      attribution: attribution.line,
      contributors: attribution.contributors,
      collection_url: `${new URL(req.url).origin}/c/${id}`,
      version,
    }),
    { httpMetadata: { contentType: 'application/json' } },
  );

  await insertSubmission(env.DB, {
    id: submissionId,
    status: 'accepted',
    name: c.name,
    description: c.description,
    category: 'other', // collections carry no category in v1
    license: c.license,
    attribution: attribution.line,
    source_url: `https://collect.bharatlas.com/c/${id}`,
    data_year: c.data_year,
    is_original: 1,
    format: 'geojson',
    bytes: bytes.byteLength,
    feature_count: features.length,
    geometry_types: geomTypes,
    content_hash: contentHash,
    ip_hash: c.ip_hash,
    validation_report: null,
    r2_key: r2Key,
  });
  await insertToken(env.DB, {
    submissionId,
    tokenPrefix: tokenPrefix(adminToken),
    tokenHash: await hashToken(adminToken),
    permission: 'admin',
  });
  await db.linkSubmission(env.DB, submissionId, id, version);
  await db.insertPublication(env.DB, {
    id: nanoid(10),
    collectionId: id,
    version,
    submissionId,
    featureCount: features.length,
    contentHash,
    attributionSnapshot: attribution.line,
    r2Key,
  });

  void logCollectAttempt(env.DB, { event: 'publish', outcome: 'ok', collection_id: id });
  return json(200, {
    version,
    submission_id: submissionId,
    feature_count: features.length,
    attribution: attribution.line,
    share_url: `${BHARATLAS_ORIGIN}/c/${submissionId}`,
    admin_token: adminToken,
  });
}
