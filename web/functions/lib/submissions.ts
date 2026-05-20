// D1 helpers for the submissions + submission_tokens tables.
// Functions are tiny so tests can mock D1 with a fake prepare/bind/run/first.

type RunnableD1 = Pick<D1Database, 'prepare'>;

export type SubmissionRow = {
  id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'retracted';
  name: string;
  description: string | null;
  category: string;
  license: string;
  attribution: string;
  /** http(s) URL when is_original=0; free-text 'method' description when 1. */
  source_url: string;
  is_original: 0 | 1;
  format: string;
  bytes: number;
  feature_count: number | null;
  geometry_types: string | null;
  content_hash: string | null;
  ip_hash: string;
  validation_report: string | null;
  r2_key: string;
};

export async function insertSubmission(db: RunnableD1, row: SubmissionRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO submissions
       (id, created_at, status, name, description, category, license, attribution, source_url, is_original,
        format, bytes, feature_count, geometry_types, content_hash, ip_hash, validation_report, r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      new Date().toISOString(),
      row.status,
      row.name,
      row.description,
      row.category,
      row.license,
      row.attribution,
      row.source_url,
      row.is_original,
      row.format,
      row.bytes,
      row.feature_count,
      row.geometry_types,
      row.content_hash,
      row.ip_hash,
      row.validation_report,
      row.r2_key,
    )
    .run();
}

export async function insertToken(
  db: RunnableD1,
  input: {
    submissionId: string;
    tokenPrefix: string;
    tokenHash: string;
    permission: 'admin' | 'edit' | 'view';
    expiresAt?: string;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO submission_tokens
       (id, submission_id, token_prefix, token_hash, permission, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.submissionId,
      input.tokenPrefix,
      input.tokenHash,
      input.permission,
      input.expiresAt ?? null,
      new Date().toISOString(),
    )
    .run();
}

export async function findDuplicateByHash(
  db: RunnableD1,
  contentHash: string,
): Promise<string | null> {
  const row = (await db
    .prepare(
      `SELECT id FROM submissions WHERE content_hash = ? AND status = 'accepted' LIMIT 1`,
    )
    .bind(contentHash)
    .first()) as { id: string } | null;
  return row?.id ?? null;
}

export type SubmissionView = {
  id: string;
  created_at: string;
  updated_at: string | null;
  status: 'accepted';
  name: string;
  description: string | null;
  category: string;
  license: string;
  attribution: string;
  source_url: string;
  is_original: 0 | 1;
  format: string;
  bytes: number;
  feature_count: number | null;
  geometry_types: string | null;
  r2_key: string;
};

export async function getSubmissionForView(
  db: RunnableD1,
  id: string,
): Promise<SubmissionView | null> {
  const row = (await db
    .prepare(
      `SELECT id, created_at, updated_at, status, name, description, category, license,
              attribution, source_url, is_original, format, bytes, feature_count, geometry_types, r2_key
       FROM submissions WHERE id = ? AND status = 'accepted' LIMIT 1`,
    )
    .bind(id)
    .first()) as SubmissionView | null;
  return row ?? null;
}
