// D1 helpers for the collect tables (migration 0007). Tiny and mockable, like
// web/functions/lib/submissions.ts. Geometry / properties / admin_ctx are stored
// as JSON TEXT; callers stringify on write and parse on read.

type DB = Pick<D1Database, 'prepare'>;

const now = () => new Date().toISOString();

// ---- collections -----------------------------------------------------------

export interface CollectionRow {
  id: string;
  created_at: string;
  updated_at: string | null;
  status: 'open' | 'closed';
  name: string;
  description: string | null;
  data_year: number | null;
  purpose: string;
  schema_doc: string;
  license: string;
  moderation: number;
  ip_hash: string;
}

export interface NewCollectionRow {
  id: string;
  name: string;
  purpose: string;
  license: string;
  description: string | null;
  data_year: number | null;
  schema_doc: string;
  moderation: number;
  ip_hash: string;
}

export async function createCollection(db: DB, c: NewCollectionRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO collections
       (id, created_at, updated_at, status, name, description, data_year, purpose, schema_doc, license, moderation, ip_hash)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(c.id, now(), now(), c.name, c.description, c.data_year, c.purpose, c.schema_doc, c.license, c.moderation, c.ip_hash)
    .run();
}

export async function getCollection(db: DB, id: string): Promise<CollectionRow | null> {
  return (await db.prepare(`SELECT * FROM collections WHERE id = ?`).bind(id).first()) as CollectionRow | null;
}

export async function touchCollection(db: DB, id: string): Promise<void> {
  await db.prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).bind(now(), id).run();
}

// ---- tokens ----------------------------------------------------------------

export async function addCollectionToken(
  db: DB,
  t: { collectionId: string; prefix: string; hash: string; permission: 'admin' | 'edit' | 'view' },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO collection_tokens (id, collection_id, token_prefix, token_hash, permission, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(crypto.randomUUID(), t.collectionId, t.prefix, t.hash, t.permission, now())
    .run();
}

export async function tokensForCollection(
  db: DB,
  collectionId: string,
  prefix: string,
): Promise<{ token_hash: string; permission: 'admin' | 'edit' | 'view'; is_active: number }[]> {
  const res = await db
    .prepare(
      `SELECT token_hash, permission, is_active FROM collection_tokens
       WHERE collection_id = ? AND token_prefix = ? AND is_active = 1`,
    )
    .bind(collectionId, prefix)
    .all();
  return (res.results ?? []) as unknown as { token_hash: string; permission: 'admin' | 'edit' | 'view'; is_active: number }[];
}

// ---- records ---------------------------------------------------------------

export interface NewRecordRow {
  id: string;
  collectionId: string;
  status: 'pending' | 'published';
  geometry: string;
  properties: string;
  admin_ctx: string | null;
  contributor: string | null;
  edit_token_hash: string;
  ip_hash: string;
  source?: string | null; // NULL = field-collected; set = imported from
}

export async function insertRecord(db: DB, r: NewRecordRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO records
       (id, collection_id, created_at, status, geometry, properties, admin_ctx, contributor, edit_token_hash, ip_hash, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.id, r.collectionId, now(), r.status, r.geometry, r.properties, r.admin_ctx, r.contributor, r.edit_token_hash, r.ip_hash, r.source ?? null)
    .run();
}

export interface RecordRow {
  id: string;
  collection_id: string;
  created_at: string;
  status: 'pending' | 'published' | 'rejected';
  geometry: string;
  properties: string;
  admin_ctx: string | null;
  contributor: string | null;
  edit_token_hash: string | null;
  source: string | null;
}

export async function listRecords(
  db: DB,
  collectionId: string,
  opts: { status?: string; limit: number; offset: number },
): Promise<RecordRow[]> {
  const parts = [`SELECT * FROM records WHERE collection_id = ?`];
  const binds: unknown[] = [collectionId];
  if (opts.status) {
    parts.push(`AND status = ?`);
    binds.push(opts.status);
  }
  parts.push(`ORDER BY created_at DESC LIMIT ? OFFSET ?`);
  binds.push(opts.limit, opts.offset);
  const res = await db.prepare(parts.join(' ')).bind(...binds).all();
  return (res.results ?? []) as unknown as RecordRow[];
}

export async function statusCounts(
  db: DB,
  collectionId: string,
): Promise<{ total: number; pending: number; published: number; rejected: number }> {
  const res = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM records WHERE collection_id = ? GROUP BY status`)
    .bind(collectionId)
    .all();
  const out = { total: 0, pending: 0, published: 0, rejected: 0 };
  for (const row of (res.results ?? []) as unknown as { status: string; n: number }[]) {
    if (row.status in out) (out as Record<string, number>)[row.status] = row.n;
    out.total += row.n;
  }
  return out;
}

export async function getRecord(db: DB, id: string): Promise<RecordRow | null> {
  return (await db.prepare(`SELECT * FROM records WHERE id = ?`).bind(id).first()) as RecordRow | null;
}

export async function setRecordStatus(
  db: DB,
  id: string,
  status: 'pending' | 'published' | 'rejected',
  reason: string | null = null,
): Promise<void> {
  await db.prepare(`UPDATE records SET status = ?, rejection_reason = ? WHERE id = ?`).bind(status, reason, id).run();
}

export async function updateRecord(
  db: DB,
  id: string,
  patch: { geometry?: string; properties?: string; status?: string; admin_ctx?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.geometry !== undefined) { sets.push('geometry = ?'); binds.push(patch.geometry); }
  if (patch.properties !== undefined) { sets.push('properties = ?'); binds.push(patch.properties); }
  if (patch.status !== undefined) { sets.push('status = ?'); binds.push(patch.status); }
  if (patch.admin_ctx !== undefined) { sets.push('admin_ctx = ?'); binds.push(patch.admin_ctx); }
  if (!sets.length) return;
  binds.push(id);
  await db.prepare(`UPDATE records SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

export async function deleteRecord(db: DB, id: string): Promise<void> {
  await db.prepare(`DELETE FROM records WHERE id = ?`).bind(id).run();
}

export async function deidentifyRecord(db: DB, id: string): Promise<void> {
  await db.prepare(`UPDATE records SET contributor = NULL WHERE id = ?`).bind(id).run();
}

// ---- publications ----------------------------------------------------------

export async function nextVersion(db: DB, collectionId: string): Promise<number> {
  const row = (await db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM publications WHERE collection_id = ?`)
    .bind(collectionId)
    .first()) as { v: number } | null;
  return (row?.v ?? 0) + 1;
}

export async function insertPublication(
  db: DB,
  p: {
    id: string;
    collectionId: string;
    version: number;
    submissionId: string;
    featureCount: number;
    contentHash: string;
    attributionSnapshot: string;
    r2Key: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO publications
       (id, collection_id, version, submission_id, published_at, feature_count, content_hash, attribution_snapshot, r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(p.id, p.collectionId, p.version, p.submissionId, now(), p.featureCount, p.contentHash, p.attributionSnapshot, p.r2Key)
    .run();
}

/** Link the produced submission back to its collection + version (0007 columns). */
export async function linkSubmission(db: DB, submissionId: string, collectionId: string, version: number): Promise<void> {
  await db
    .prepare(`UPDATE submissions SET collection_id = ?, collection_version = ? WHERE id = ?`)
    .bind(collectionId, version, submissionId)
    .run();
}
