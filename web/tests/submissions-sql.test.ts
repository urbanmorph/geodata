// The public submissions API's SQL, run against a database built from the real
// migrations. Catches a query that names a column no migration creates (the
// list/detail queries selected a missing `useful_count`, failed on every
// request and silently fell back to a query without data_year or votes).
import { describe, it, expect, beforeAll } from 'vitest';
import { submissionListSql, submissionCountSql, SUBMISSION_DETAIL_SQL, SUBMISSION_VIEW_SQL, containsPattern, SEARCH_WHERE, MAX_SEARCH_CHARS } from '../functions/lib/submissions-sql';

import { migratedDb, type SqliteDb } from './helpers/sqlite-d1';

let db: SqliteDb;

beforeAll(() => {
  db = migratedDb();
  const ins = db.prepare(`INSERT INTO submissions (id, created_at, status, name, category, license, attribution, source_url, format, bytes, ip_hash, r2_key, data_year)
    VALUES (?, ?, 'accepted', ?, 'environment', 'CC0-1.0', 'x', 'https://x', 'geojson', 10, 'h', 'k', ?)`);
  ins.run('aaa', '2026-01-01', 'Older, liked', 2019);
  ins.run('bbb', '2026-02-01', 'Newer, unliked', null);
  const vote = db.prepare(`INSERT INTO submission_ratings (submission_id, ip_hash, created_at, vote) VALUES (?, ?, '2026-03-01', ?)`);
  vote.run('aaa', 'v1', 1);
  vote.run('aaa', 'v2', 1);
  vote.run('bbb', 'v3', -1);
});

describe('submissions SQL', () => {
  it('lists with data_year and useful_count counted from votes', () => {
    const rows = db.prepare(submissionListSql("status = 'accepted'", 'useful')).all(10, 0) as Record<string, unknown>[];
    expect(rows.map((r) => r.id)).toEqual(['aaa', 'bbb']);
    expect(rows[0]).toMatchObject({ data_year: 2019, useful_count: 2 });
    expect(rows[1]).toMatchObject({ useful_count: 0 });
  });

  it('newest first by default', () => {
    const rows = db.prepare(submissionListSql("status = 'accepted'", 'newest')).all(10, 0) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['bbb', 'aaa']);
  });

  it('counts and fetches one with the same columns', () => {
    expect(db.prepare(submissionCountSql("status = 'accepted'")).get()).toEqual({ n: 2 });
    expect(db.prepare(SUBMISSION_DETAIL_SQL).get('aaa')).toMatchObject({ id: 'aaa', data_year: 2019, useful_count: 2 });
  });

  it('the /c/<id> page query carries data_year (its "Data year" line)', () => {
    expect(db.prepare(SUBMISSION_VIEW_SQL).get('aaa')).toMatchObject({ id: 'aaa', data_year: 2019, is_original: expect.anything() });
  });
});

describe('search text is matched literally', () => {
  const search = (q: string) => (db.prepare(submissionListSql(`status = 'accepted'${SEARCH_WHERE}`, 'newest'))
    .all(containsPattern(q), containsPattern(q), 10, 0) as { id: string }[]).map((r) => r.id);
  it('% and _ are characters, not wildcards', () => {
    expect(search('liked')).toEqual(['bbb', 'aaa']);
    expect(search('%')).toEqual([]);
    expect(search('_')).toEqual([]);
    expect(search('Older, liked')).toEqual(['aaa']);
  });
  it('is cut to MAX_SEARCH_CHARS', () => {
    expect(containsPattern('x'.repeat(500))).toHaveLength(MAX_SEARCH_CHARS + 2);
    expect(containsPattern('a%b_c\\')).toBe('%a\\%b\\_c\\\\%');
  });
});
