// The owner's list of every record (all statuses, newest first) reads an index
// in that order instead of sorting the whole map on every page.
import { describe, it, expect } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';

describe('records index for the all-status list', () => {
  it('serves ORDER BY created_at DESC, id DESC without a sort step', () => {
    const db = sqliteD1();
    const plan = db.raw.prepare(`EXPLAIN QUERY PLAN SELECT * FROM records WHERE collection_id = ?
      AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all('c', 'z', 'z', 'z', 10) as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join(' | ');
    expect(text).toMatch(/idx_rec_coll_created/);
    expect(text).not.toMatch(/TEMP B-TREE/);
  });
});
