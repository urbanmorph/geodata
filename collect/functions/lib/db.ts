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

// Admin edit of collection metadata. `col` keys are trusted column names from
// validateCollectionEdit (name/purpose/description/data_year/license); schema_doc
// is a pre-serialised merge.
export async function updateCollection(db: DB, id: string, col: Record<string, unknown>, schemaDoc?: string): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(col)) { sets.push(`${k} = ?`); binds.push(v); }
  if (schemaDoc !== undefined) { sets.push('schema_doc = ?'); binds.push(schemaDoc); }
  sets.push('updated_at = ?'); binds.push(now());
  binds.push(id);
  await db.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

// ---- tokens ----------------------------------------------------------------

export async function addCollectionToken(
  db: DB,
  t: { collectionId: string; prefix: string; hash: string; permission: 'admin' | 'edit' | 'view'; label?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO collection_tokens (id, collection_id, token_prefix, token_hash, permission, is_active, created_at, label)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, t.collectionId, t.prefix, t.hash, t.permission, now(), t.label ?? null)
    .run();
  return id;
}

export async function tokensForCollection(
  db: DB,
  collectionId: string,
  prefix: string,
): Promise<{ id: string; token_hash: string; permission: 'admin' | 'edit' | 'view'; is_active: number }[]> {
  const res = await db
    .prepare(
      `SELECT id, token_hash, permission, is_active FROM collection_tokens
       WHERE collection_id = ? AND token_prefix = ? AND is_active = 1`,
    )
    .bind(collectionId, prefix)
    .all();
  return (res.results ?? []) as unknown as { id: string; token_hash: string; permission: 'admin' | 'edit' | 'view'; is_active: number }[];
}

export interface LinkRow {
  id: string;
  permission: 'admin' | 'edit' | 'view';
  label: string | null;
  is_active: number;
  created_at: string;
  records: number;
}

// Every link on a collection with how many records each added (admin view).
// Never selects the hash: links are shown once at mint and can't be re-shown.
export async function listLinks(db: DB, collectionId: string): Promise<LinkRow[]> {
  const res = await db
    .prepare(
      `SELECT t.id, t.permission, t.label, t.is_active, t.created_at,
              (SELECT COUNT(*) FROM records r WHERE r.collection_id = t.collection_id AND r.token_id = t.id) AS records
       FROM collection_tokens t WHERE t.collection_id = ? ORDER BY t.created_at`,
    )
    .bind(collectionId)
    .all();
  return (res.results ?? []) as unknown as LinkRow[];
}

export async function getLink(db: DB, collectionId: string, tokenId: string): Promise<{ id: string; permission: string } | null> {
  return (await db
    .prepare(`SELECT id, permission FROM collection_tokens WHERE collection_id = ? AND id = ?`)
    .bind(collectionId, tokenId)
    .first()) as { id: string; permission: string } | null;
}

export async function deactivateLink(db: DB, collectionId: string, tokenId: string): Promise<void> {
  await db.prepare(`UPDATE collection_tokens SET is_active = 0 WHERE collection_id = ? AND id = ?`).bind(collectionId, tokenId).run();
}

// token id → label for one collection, to annotate the admin's record list.
export async function linkLabels(db: DB, collectionId: string): Promise<Map<string, string | null>> {
  const res = await db.prepare(`SELECT id, label FROM collection_tokens WHERE collection_id = ?`).bind(collectionId).all();
  return new Map(((res.results ?? []) as unknown as { id: string; label: string | null }[]).map((r) => [r.id, r.label]));
}

// ---- API keys (programmatic create gate) -----------------------------------

export async function apiKeysByPrefix(
  db: DB,
  prefix: string,
): Promise<{ id: string; key_hash: string; daily_limit: number }[]> {
  const res = await db
    .prepare(`SELECT id, key_hash, daily_limit FROM collect_api_keys WHERE key_prefix = ? AND revoked = 0`)
    .bind(prefix)
    .all();
  return (res.results ?? []) as unknown as { id: string; key_hash: string; daily_limit: number }[];
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
  token_id?: string | null; // collection_tokens.id that added it; NULL = imported
  client_key_hash?: string | null; // SHA-256 of a queued point's client_id; NULL = not queued
  captured_at?: string | null; // when the phone captured it; NULL = use created_at
  ai?: string | null; // JSON notes from the model (functions/lib/ai.ts); NULL = none
}

/** The INSERT for one record, unrun (bulk import writes these in batches). */
export function recordInsert(db: DB, r: NewRecordRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO records
       (id, collection_id, created_at, status, geometry, properties, admin_ctx, contributor, edit_token_hash, ip_hash, source, token_id, client_key_hash, captured_at, ai)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.id, r.collectionId, now(), r.status, r.geometry, r.properties, r.admin_ctx, r.contributor, r.edit_token_hash, r.ip_hash, r.source ?? null, r.token_id ?? null, r.client_key_hash ?? null, r.captured_at ?? null, r.ai ?? null);
}

export async function insertRecord(db: DB, r: NewRecordRow): Promise<void> {
  await recordInsert(db, r).run();
}

// A queued point already saved on this map (the offline queue may send it twice).
export async function recordByClientKey(db: DB, collectionId: string, clientKeyHash: string): Promise<{ id: string; status: string } | null> {
  return (await db
    .prepare(`SELECT id, status FROM records WHERE collection_id = ? AND client_key_hash = ?`)
    .bind(collectionId, clientKeyHash)
    .first()) as { id: string; status: string } | null;
}

export async function setRecordTokenHash(db: DB, id: string, editTokenHash: string): Promise<void> {
  await db.prepare(`UPDATE records SET edit_token_hash = ? WHERE id = ?`).bind(editTokenHash, id).run();
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
  token_id: string | null;
  captured_at: string | null;
  ai: string | null;
}

/** Every record's properties (only that column, page by page): what the form-edit check needs. */
export async function allRecordProperties(db: DB, collectionId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const PAGE = 2000;
  for (let offset = 0; ; offset += PAGE) {
    const { results } = await db
      .prepare(`SELECT properties FROM records WHERE collection_id = ? ORDER BY id LIMIT ? OFFSET ?`)
      .bind(collectionId, PAGE, offset)
      .all<{ properties: string }>();
    for (const r of results) out.push(JSON.parse(r.properties) as Record<string, unknown>);
    if (results.length < PAGE) return out;
  }
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

// Bulk status move for one collection (the "Approve all" action). Returns the
// number of rows changed so the caller can report "approved N".
export async function setAllRecordStatus(
  db: DB,
  collectionId: string,
  from: 'pending' | 'rejected',
  to: 'published' | 'rejected',
): Promise<number> {
  const res = await db
    .prepare(`UPDATE records SET status = ? WHERE collection_id = ? AND status = ?`)
    .bind(to, collectionId, from)
    .run();
  return (res.meta?.changes as number) ?? 0;
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

/** The INSERT for one publication row, unrun, for a D1 batch. */
export function publicationInsert(
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
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO publications
       (id, collection_id, version, submission_id, published_at, feature_count, content_hash, attribution_snapshot, r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(p.id, p.collectionId, p.version, p.submissionId, now(), p.featureCount, p.contentHash, p.attributionSnapshot, p.r2Key);
}

/** Link the produced submission back to its collection + version (0007
 *  columns). Unrun, for a D1 batch after the submission row. */
export function linkSubmissionStatement(db: DB, submissionId: string, collectionId: string, version: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE submissions SET collection_id = ?, collection_version = ? WHERE id = ?`)
    .bind(collectionId, version, submissionId);
}

// ---- keyrings (opt-in encrypted sync; migration 0011) -----------------------

export interface KeyringRow { id: string; write_hash: string; blob: string; updated_at: string; }

export async function getKeyring(db: DB, id: string): Promise<KeyringRow | null> {
  return (await db.prepare(`SELECT id, write_hash, blob, updated_at FROM collect_keyrings WHERE id = ?`).bind(id).first()) as KeyringRow | null;
}

export async function touchKeyring(db: DB, id: string): Promise<void> {
  await db.prepare(`UPDATE collect_keyrings SET used_at = ? WHERE id = ?`).bind(now(), id).run();
}

export async function insertKeyring(db: DB, k: { id: string; write_hash: string; blob: string }): Promise<string> {
  const t = now();
  await db
    .prepare(`INSERT INTO collect_keyrings (id, write_hash, blob, created_at, updated_at, used_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(k.id, k.write_hash, k.blob, t, t, t)
    .run();
  return t;
}

// Compare-and-set on updated_at: returns the new updated_at, or null when
// another device wrote first (the caller answers 409).
export async function updateKeyring(db: DB, id: string, blob: string, base: string): Promise<string | null> {
  const t = now();
  const r = await db
    .prepare(`UPDATE collect_keyrings SET blob = ?, updated_at = ?, used_at = ? WHERE id = ? AND updated_at = ?`)
    .bind(blob, t, t, id, base)
    .run();
  return r.meta.changes ? t : null;
}

export async function deleteKeyring(db: DB, id: string): Promise<void> {
  await db.prepare(`DELETE FROM collect_keyrings WHERE id = ?`).bind(id).run();
}

export async function purgeStaleKeyrings(db: DB, olderThan: string): Promise<void> {
  await db.prepare(`DELETE FROM collect_keyrings WHERE used_at < ?`).bind(olderThan).run();
}
