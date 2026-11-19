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

/** The INSERT for a new collection, unrun (createCollection batches it with its links). */
export function collectionInsert(db: DB, c: NewCollectionRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collections
       (id, created_at, updated_at, status, name, description, data_year, purpose, schema_doc, license, moderation, ip_hash)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(c.id, now(), now(), c.name, c.description, c.data_year, c.purpose, c.schema_doc, c.license, c.moderation, c.ip_hash);
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

type NewToken = { collectionId: string; prefix: string; hash: string; permission: 'admin' | 'edit' | 'view'; label?: string | null };

export function insertToken(db: DB, t: NewToken): { id: string; stmt: D1PreparedStatement } {
  const id = crypto.randomUUID();
  const stmt = db
    .prepare(
      `INSERT INTO collection_tokens (id, collection_id, token_prefix, token_hash, permission, is_active, created_at, label)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, t.collectionId, t.prefix, t.hash, t.permission, now(), t.label ?? null);
  return { id, stmt };
}

export async function addCollectionToken(db: DB, t: NewToken): Promise<string> {
  const { id, stmt } = insertToken(db, t);
  await stmt.run();
  return id;
}

// Turn off every admin link of a map and add the new one, in one transaction:
// either the map has exactly the new admin link, or nothing changed.
export async function swapAdminToken(db: DB & Pick<D1Database, 'batch'>, collectionId: string, prefix: string, hash: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE collection_tokens SET is_active = 0 WHERE collection_id = ? AND permission = 'admin'`).bind(collectionId),
    insertToken(db, { collectionId, prefix, hash, permission: 'admin' }).stmt,
  ]);
}

// Was this token a real link that has since been turned off? (Lets a 401 say
// why, instead of a bare "unauthorised", to whoever still holds the old link.)
export async function retiredTokens(db: DB, prefix: string): Promise<{ token_hash: string; permission: 'admin' | 'edit' | 'view' }[]> {
  const res = await db
    .prepare(`SELECT token_hash, permission FROM collection_tokens WHERE token_prefix = ? AND is_active = 0`)
    .bind(prefix)
    .all();
  return (res.results ?? []) as unknown as { token_hash: string; permission: 'admin' | 'edit' | 'view' }[];
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

export async function getLink(db: DB, collectionId: string, tokenId: string): Promise<{ id: string; permission: string; label: string | null } | null> {
  return (await db
    .prepare(`SELECT id, permission, label FROM collection_tokens WHERE collection_id = ? AND id = ?`)
    .bind(collectionId, tokenId)
    .first()) as { id: string; permission: string; label: string | null } | null;
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
  import_client_id?: string | null; // the importer's own id for the row; NULL = none (re-import adds it again)
}

const INSERT_RECORD = `INSERT INTO records
  (id, collection_id, created_at, status, geometry, properties, admin_ctx, contributor, edit_token_hash, ip_hash, source, token_id, client_key_hash, captured_at, ai, import_client_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function recordStatement(db: DB, sql: string, r: NewRecordRow): D1PreparedStatement {
  return db.prepare(sql).bind(
    r.id, r.collectionId, now(), r.status, r.geometry, r.properties, r.admin_ctx, r.contributor, r.edit_token_hash, r.ip_hash,
    r.source ?? null, r.token_id ?? null, r.client_key_hash ?? null, r.captured_at ?? null, r.ai ?? null, r.import_client_id ?? null,
  );
}

export async function insertRecord(db: DB, r: NewRecordRow): Promise<void> {
  await recordStatement(db, INSERT_RECORD, r).run();
}

/** One imported row, unrun (bulk import writes these in batches). A row whose
 *  (map, import_client_id) already exists is updated in place, keeping its id,
 *  status and edit token; it is touched only if its data differs. RETURNING id
 *  tells the three apart: r.id = added, another id = updated, no row = unchanged. */
export function recordImport(db: DB, r: NewRecordRow): D1PreparedStatement {
  return recordStatement(db, `${INSERT_RECORD}
    ON CONFLICT (collection_id, import_client_id) WHERE import_client_id IS NOT NULL DO UPDATE SET
      geometry = excluded.geometry, properties = excluded.properties, source = excluded.source, contributor = excluded.contributor,
      admin_ctx = CASE WHEN records.geometry = excluded.geometry THEN records.admin_ctx END
    WHERE records.geometry IS NOT excluded.geometry OR records.properties IS NOT excluded.properties
       OR records.source IS NOT excluded.source OR records.contributor IS NOT excluded.contributor
    RETURNING id`, r);
}

// A queued point already saved on this map (the offline queue may send it twice).
export async function recordByClientKey(db: DB, collectionId: string, clientKeyHash: string): Promise<{ id: string; status: string; properties: string } | null> {
  return (await db
    .prepare(`SELECT id, status, properties FROM records WHERE collection_id = ? AND client_key_hash = ?`)
    .bind(collectionId, clientKeyHash)
    .first()) as { id: string; status: string; properties: string } | null;
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

/** Every record's id and answers (only those columns, page by page), optionally
 *  of one status: what the form-edit check and approve-all need, without loading
 *  geometry, notes and the rest into memory. */
export async function recordAnswers(db: DB, collectionId: string, status?: string): Promise<Array<{ id: string; properties: Record<string, unknown> }>> {
  const out: Array<{ id: string; properties: Record<string, unknown> }> = [];
  const PAGE = 2000;
  for (let after = ''; ;) {
    const { results } = await db
      .prepare(`SELECT id, properties FROM records WHERE collection_id = ? AND id > ?${status ? ' AND status = ?' : ''} ORDER BY id LIMIT ?`)
      .bind(collectionId, after, ...(status ? [status] : []), PAGE)
      .all<{ id: string; properties: string }>();
    for (const r of results) out.push({ id: r.id, properties: JSON.parse(r.properties) as Record<string, unknown> });
    if (results.length < PAGE) return out;
    after = results[results.length - 1].id;
  }
}

/** Where a page of records ended: the last row's (created_at, id). */
export interface RecordCursor { created_at: string; id: string }

/** Newest first, ties broken by id, so the order is the same on every call and
 *  pages never overlap or skip. `after` (keyset) continues past a cursor even
 *  while new points arrive; `offset` stays part of the public API. `geometryOnly`
 *  reads just what a map needs to draw the records. */
export async function listRecords(
  db: DB,
  collectionId: string,
  opts: { status?: string; limit: number; offset?: number; after?: RecordCursor; geometryOnly?: boolean },
): Promise<RecordRow[]> {
  const parts = [`SELECT ${opts.geometryOnly ? 'id, created_at, geometry' : '*'} FROM records WHERE collection_id = ?`];
  const binds: unknown[] = [collectionId];
  if (opts.status) {
    parts.push(`AND status = ?`);
    binds.push(opts.status);
  }
  if (opts.after) {
    parts.push(`AND (created_at < ? OR (created_at = ? AND id < ?))`);
    binds.push(opts.after.created_at, opts.after.created_at, opts.after.id);
  }
  parts.push(`ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`);
  binds.push(opts.limit, opts.after ? 0 : opts.offset ?? 0);
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

/** Moves these records (all on one map, still in `from`) to `to`: one UPDATE
 *  per few thousand ids (the ids ride as one JSON parameter, under D1's limit of
 *  100 bound parameters), unrun, for one D1 batch, so it is all or nothing. */
export function setStatusOfIds(
  db: DB, collectionId: string, ids: string[], from: string, to: 'published' | 'rejected',
): D1PreparedStatement[] {
  const CHUNK = 5000;
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(db
      .prepare(`UPDATE records SET status = ?, rejection_reason = NULL
                WHERE collection_id = ? AND status = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(to, collectionId, from, JSON.stringify(ids.slice(i, i + CHUNK))));
  }
  return out;
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
