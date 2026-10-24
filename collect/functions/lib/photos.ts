// Photos on collect points. The phone resizes each photo (keeping only where and
// when it was taken) and uploads it before the point; the point then claims its
// photos by id. A photo is private (its map's admin, or the contributor of its
// point) until its point is approved, then public under the map's open licence.
// Deleting a point deletes its photos; photos never claimed are cleared after a day.
import type { Env } from '../types';
import { bad, json } from './http';
import { bearer, linkFor, atLeast } from './auth';
import { hashToken, verifyToken } from './tokens';
import { nanoid, ipHashFor } from './reuse';
import { checkPhotoRate } from './ratelimit';
import { isInIndia } from '../../src/geo/bounds';
import { PHOTO_ID, type Field } from '../../src/schema/validate-record';

export const MAX_PHOTO_BYTES = 2_000_000; // the phone sends ~300 KB; this is a safety cap
const ORPHAN_AGE_MS = 86_400_000;
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;

const salt = (env: Env) => env.IP_SALT || 'collect-v1';
const r2Key = (collectionId: string, id: string) => `collect/${collectionId}/photos/${id}.jpg`;
export const photoUrl = (origin: string, id: string) => `${origin}/api/collect/v1/photos/${id}`;

export interface PhotoRow {
  id: string; collection_id: string; record_id: string | null; r2_key: string; bytes: number;
  lat: number | null; lng: number | null; taken_at: string | null; source: string | null; created_at: string;
}

/** What the camera recorded, kept only when it makes sense. */
function cleanMeta(raw: string | null): { lat: number | null; lng: number | null; taken_at: string | null; source: string | null } {
  let m: Record<string, unknown> = {};
  try { m = raw ? JSON.parse(raw) : {}; } catch { /* no metadata */ }
  const lat = typeof m.lat === 'number' ? m.lat : NaN;
  const lng = typeof m.lng === 'number' ? m.lng : NaN;
  const place = Number.isFinite(lat) && Number.isFinite(lng) && isInIndia(lng, lat);
  const t = typeof m.taken_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(m.taken_at) ? Date.parse(m.taken_at) : NaN;
  return {
    lat: place ? lat : null,
    lng: place ? lng : null,
    taken_at: Number.isFinite(t) && t <= Date.now() + 600_000 ? new Date(t).toISOString() : null,
    source: m.source === 'camera' || m.source === 'gallery' ? m.source : null,
  };
}

// ---- POST /collections/:id/photos (body: the JPEG) ----------------------------

export async function uploadPhoto(env: Env, req: Request, collectionId: string, defer?: (p: Promise<unknown>) => void): Promise<Response> {
  const via = await linkFor(env.DB, collectionId, bearer(req));
  if (!atLeast(via?.permission ?? null, 'edit')) return bad(401, 'unauthorised — need the edit or admin link');
  const c = (await env.DB.prepare('SELECT status FROM collections WHERE id = ?').bind(collectionId).first()) as { status: string } | null;
  if (!c) return bad(404, 'not found');
  if (c.status === 'closed') return bad(403, 'this collection is closed to new records');

  const clientId = req.headers.get('x-client-id') ?? '';
  if (!CLIENT_ID.test(clientId)) return bad(400, 'x-client-id must be 16 to 64 letters, digits, - or _');
  const clientKey = await hashToken(clientId);
  const seen = (await env.DB.prepare('SELECT id FROM collect_photos WHERE collection_id = ? AND client_key_hash = ?')
    .bind(collectionId, clientKey).first()) as { id: string } | null;
  if (seen) return json(200, { id: seen.id, url: photoUrl(new URL(req.url).origin, seen.id) });

  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_PHOTO_BYTES) return bad(413, 'photo too large');
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_PHOTO_BYTES) return bad(413, 'photo too large');
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return bad(400, 'a photo must be a JPEG');

  const ipHash = await ipHashFor(req, salt(env));
  if (!(await checkPhotoRate(env.DB, ipHash))) return bad(429, 'rate limit: too many photos this hour');

  const id = `ph_${nanoid(16)}`;
  const key = r2Key(collectionId, id);
  await env.R2.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  const meta = cleanMeta(req.headers.get('x-photo-meta'));
  try {
    await env.DB.prepare(
      `INSERT INTO collect_photos (id, collection_id, record_id, r2_key, bytes, lat, lng, taken_at, source, client_key_hash, ip_hash, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, collectionId, key, bytes.byteLength, meta.lat, meta.lng, meta.taken_at, meta.source, clientKey, ipHash, new Date().toISOString()).run();
  } catch (e) {
    await env.R2.delete(key);
    // Two repeats raced: the unique index kept the first. Return it.
    const raced = (await env.DB.prepare('SELECT id FROM collect_photos WHERE collection_id = ? AND client_key_hash = ?')
      .bind(collectionId, clientKey).first()) as { id: string } | null;
    if (raced) return json(200, { id: raced.id, url: photoUrl(new URL(req.url).origin, raced.id) });
    throw e;
  }
  const task = purgeOrphans(env, collectionId).catch(() => {});
  if (defer) defer(task); else await task;
  return json(200, { id, url: photoUrl(new URL(req.url).origin, id) });
}

/** Photos uploaded but never claimed by a point (the point was abandoned). */
export async function purgeOrphans(env: Env, collectionId: string): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHAN_AGE_MS).toISOString();
  const { results } = await env.DB.prepare(
    'SELECT id, r2_key FROM collect_photos WHERE collection_id = ? AND record_id IS NULL AND created_at < ? LIMIT 50',
  ).bind(collectionId, cutoff).all<{ id: string; r2_key: string }>();
  await removePhotos(env, results);
}

async function removePhotos(env: Env, rows: Array<{ id: string; r2_key: string }>): Promise<void> {
  if (!rows.length) return;
  await env.R2.delete(rows.map((r) => r.r2_key));
  for (const r of rows) await env.DB.prepare('DELETE FROM collect_photos WHERE id = ?').bind(r.id).run();
}

// ---- GET /photos/:id ------------------------------------------------------------

export async function getPhoto(env: Env, req: Request, id: string): Promise<Response> {
  if (!PHOTO_ID.test(id)) return bad(404, 'not found');
  const p = (await env.DB.prepare(
    `SELECT p.r2_key, p.collection_id, p.record_id, r.status, r.edit_token_hash, c.schema_doc
       FROM collect_photos p LEFT JOIN records r ON r.id = p.record_id JOIN collections c ON c.id = p.collection_id
      WHERE p.id = ?`,
  ).bind(id).first()) as { r2_key: string; collection_id: string; record_id: string | null; status: string | null; edit_token_hash: string | null; schema_doc: string } | null;
  if (!p) return bad(404, 'not found');

  const hidden = new Set((JSON.parse(p.schema_doc) as { fields: Field[] }).fields.filter((f) => f.deleted).map((f) => f.key));
  const isPublic = p.status === 'published' && !(hidden.size && (await photoInHiddenField(env, p.record_id!, id, hidden)));
  if (!isPublic) {
    const token = bearer(req);
    const admin = atLeast((await linkFor(env.DB, p.collection_id, token))?.permission ?? null, 'admin');
    const owner = !!token && !!p.edit_token_hash && (await verifyToken(token, p.edit_token_hash));
    if (!admin && !owner) return bad(401, 'unauthorised');
  }
  const obj = await env.R2.get(p.r2_key);
  if (!obj) return bad(404, 'not found');
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'image/jpeg',
      'access-control-allow-origin': '*',
      'cache-control': isPublic ? 'public, max-age=86400' : 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function photoInHiddenField(env: Env, recordId: string, photoId: string, hidden: Set<string>): Promise<boolean> {
  const r = (await env.DB.prepare('SELECT properties FROM records WHERE id = ?').bind(recordId).first()) as { properties: string } | null;
  const props = r ? (JSON.parse(r.properties) as Record<string, unknown>) : {};
  return [...hidden].some((k) => Array.isArray(props[k]) && (props[k] as unknown[]).includes(photoId));
}

// ---- photos claimed by points ------------------------------------------------------

/** Every photo id a point's answers refer to. */
export function photoIdsIn(fields: Field[], props: Record<string, unknown>): string[] {
  return fields.filter((f) => f.type === 'photo').flatMap((f) => (Array.isArray(props[f.key]) ? (props[f.key] as string[]) : []));
}

/** Why these photos can't go on this point (another map's, or another point's), or null. */
export async function checkPhotos(env: Env, collectionId: string, ids: string[], recordId: string | null): Promise<string | null> {
  if (!ids.length) return null;
  if (new Set(ids).size !== ids.length) return 'the same photo is used twice';
  const { results } = await env.DB.prepare(
    `SELECT id, record_id FROM collect_photos WHERE collection_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  ).bind(collectionId, ...ids).all<{ id: string; record_id: string | null }>();
  if (results.length !== ids.length) return 'a photo was not uploaded to this map; take it again';
  if (results.some((r) => r.record_id && r.record_id !== recordId)) return 'a photo already belongs to another point';
  return null;
}

/** Give a point exactly these photos: claim new ones, delete ones it no longer uses. */
export async function setPhotos(env: Env, recordId: string, ids: string[]): Promise<void> {
  const { results } = await env.DB.prepare('SELECT id, r2_key FROM collect_photos WHERE record_id = ?').bind(recordId).all<{ id: string; r2_key: string }>();
  await removePhotos(env, results.filter((r) => !ids.includes(r.id)));
  for (const id of ids) await env.DB.prepare('UPDATE collect_photos SET record_id = ? WHERE id = ? AND record_id IS NULL').bind(recordId, id).run();
}

export const deletePhotosOf = (env: Env, recordId: string): Promise<void> => setPhotos(env, recordId, []);

/** The point's photos as links, for lists, downloads and published data. */
export function photoLinks(fields: Field[], props: Record<string, unknown>, origin: string): Array<{ field: string; id: string; url: string }> {
  return fields.filter((f) => f.type === 'photo' && !f.deleted)
    .flatMap((f) => (Array.isArray(props[f.key]) ? (props[f.key] as string[]) : []).map((id) => ({ field: f.key, id, url: photoUrl(origin, id) })));
}

/** First photo of a point, for the model. */
export async function firstPhotoBytes(env: Env, recordId: string, firstId: string | undefined): Promise<Uint8Array | null> {
  if (!firstId) return null;
  const p = (await env.DB.prepare('SELECT r2_key FROM collect_photos WHERE id = ? AND record_id = ?').bind(firstId, recordId).first()) as { r2_key: string } | null;
  const obj = p ? await env.R2.get(p.r2_key) : null;
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}
