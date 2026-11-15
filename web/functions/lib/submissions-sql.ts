// SQL for the public submissions API (/api/v1/submissions[/<id>]). Votes live
// in submission_ratings (migration 0004), so useful_count is counted there;
// there is no useful_count column. tests/submissions-sql.test.ts runs these
// against a database built from the migrations.

const COLUMNS = `id, created_at, name, description, category, license, attribution,
  source_url, data_year, format, bytes, feature_count, geometry_types,
  (SELECT COUNT(*) FROM submission_ratings r WHERE r.submission_id = submissions.id AND r.vote = 1) AS useful_count`;

export type SubmissionSort = 'useful' | 'newest';

/** Page of submissions matching `where` (binds: ...where binds, limit, offset). */
export function submissionListSql(where: string, sort: SubmissionSort): string {
  const order = sort === 'useful' ? 'useful_count DESC, created_at DESC' : 'created_at DESC';
  return `SELECT ${COLUMNS} FROM submissions WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`;
}

export function submissionCountSql(where: string): string {
  return `SELECT COUNT(*) AS n FROM submissions WHERE ${where}`;
}

/** One accepted submission by id (bind: id). */
export const SUBMISSION_DETAIL_SQL =
  `SELECT ${COLUMNS}, updated_at, status, r2_key FROM submissions WHERE id = ? AND status = 'accepted'`;

/** The /c/<id> view page's row (bind: id). */
export const SUBMISSION_VIEW_SQL =
  `SELECT id, created_at, updated_at, status, name, description, category, license, attribution,
     source_url, is_original, data_year, format, bytes, feature_count, geometry_types, r2_key
   FROM submissions WHERE id = ? AND status = 'accepted' LIMIT 1`;
