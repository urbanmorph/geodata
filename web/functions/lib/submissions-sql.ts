// SQL for the public submissions API (/api/v1/submissions[/<id>]). Votes live
// in submission_ratings (migration 0004), so useful_count is counted there;
// there is no useful_count column. tests/submissions-sql.test.ts runs these
// against a database built from the migrations.

/** A community submission id (nanoid(10); 8-16 allowed for older ones). */
export const SUBMISSION_ID = /^[A-Za-z0-9_-]{8,16}$/;

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

const ONE_ACCEPTED = `FROM submissions WHERE id = ? AND status = 'accepted' LIMIT 1`;

/** One accepted submission by id, for the API (bind: id). */
export const SUBMISSION_DETAIL_SQL = `SELECT ${COLUMNS}, updated_at, status, r2_key ${ONE_ACCEPTED}`;

/** The /c/<id> view page's row: the API's columns minus the vote count, plus
 *  is_original (bind: id). */
export const SUBMISSION_VIEW_SQL =
  `SELECT id, created_at, updated_at, status, name, description, category, license, attribution,
     source_url, is_original, data_year, format, bytes, feature_count, geometry_types, r2_key ${ONE_ACCEPTED}`;

/** Longest search text the list accepts; longer is cut. */
export const MAX_SEARCH_CHARS = 100;

/** A LIKE pattern matching `q` anywhere, with %, _ and \ in it taken literally
 *  (use with ESCAPE '\\'), cut to MAX_SEARCH_CHARS. */
export function containsPattern(q: string): string {
  return `%${q.slice(0, MAX_SEARCH_CHARS).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The search clause for containsPattern binds (name, then description). */
export const SEARCH_WHERE = ` AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`;
