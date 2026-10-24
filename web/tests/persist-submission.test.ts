import { describe, it, expect } from 'vitest';
import { sqliteD1 } from '../../collect/tests/functions/helpers/sqlite-d1';
import { persistSubmission, type StoredFile } from '../functions/lib/persist-submission';
import type { SubmissionRow } from '../functions/lib/submissions';

// A submission is stored completely (file + submission row + admin token) or
// not at all. Oct 2026: the old Promise.all write raced the token row ahead of
// its submission row (foreign key), returned an error, and left an orphan row
// whose 14 MB file was never stored. Runs against the real schema (SQLite).

function fakeR2(opts: { failPutOn?: string; shortWriteOn?: string; failDelete?: boolean } = {}) {
  const objects = new Map<string, number>();
  return {
    objects,
    async put(key: string, body: ArrayBuffer | string) {
      if (key === opts.failPutOn) throw new Error('R2 put failed: network connection lost');
      const size = typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;
      const stored = key === opts.shortWriteOn ? size - 1 : size;
      objects.set(key, stored);
      return { key, size: stored };
    },
    async delete(keys: string | string[]) {
      if (opts.failDelete) throw new Error('R2 delete failed');
      for (const k of [keys].flat()) objects.delete(k);
    },
  };
}

const row = (id: string): SubmissionRow => ({
  id, status: 'pending', name: 'Test layer', description: null, category: 'transport', license: 'CC0-1.0',
  attribution: 'Someone', source_url: 'https://example.org', data_year: null, is_original: 0, format: 'geojson',
  bytes: 5, feature_count: 1, geometry_types: 'Point', content_hash: 'h', ip_hash: 'ip', validation_report: null,
  r2_key: `community/${id}/f.geojson`,
});
const file = (id: string): StoredFile => ({ key: `community/${id}/f.geojson`, body: new TextEncoder().encode('{"a":1}').buffer });
const token = (id: string) => ({ submissionId: id, tokenPrefix: 'adm_abcd', tokenHash: 'hash', permission: 'admin' as const });

async function counts(db: ReturnType<typeof sqliteD1>) {
  const s = (await db.prepare('SELECT COUNT(*) n FROM submissions').first()) as { n: number };
  const t = (await db.prepare('SELECT COUNT(*) n FROM submission_tokens').first()) as { n: number };
  return { submissions: s.n, tokens: t.n };
}

describe('persistSubmission', () => {
  it('stores the file, the submission row and its admin token', async () => {
    const db = sqliteD1();
    const r2 = fakeR2();
    const out = await persistSubmission({ r2, db }, { files: [file('s1')], submission: row('s1'), adminToken: token('s1') });
    expect(out).toEqual({ ok: true });
    expect(r2.objects.get('community/s1/f.geojson')).toBe(7);
    expect(await counts(db)).toEqual({ submissions: 1, tokens: 1 });
  });

  it('keeps nothing when the rows fail: no rows, file deleted, exact error reported', async () => {
    const db = sqliteD1();
    const r2 = fakeR2();
    // Admin token pointing at a submission that doesn't exist: foreign key fails.
    const out = await persistSubmission({ r2, db }, { files: [file('s2')], submission: row('s2'), adminToken: token('nope') });
    expect(out).toMatchObject({ ok: false, step: 'write_rows', cleanup: 'deleted 1 file(s)' });
    expect(out.ok === false && out.detail).toMatch(/FOREIGN KEY/i);
    expect(r2.objects.size).toBe(0);
    expect(await counts(db)).toEqual({ submissions: 0, tokens: 0 });
  });

  it('keeps nothing when a file fails to store, and never writes rows', async () => {
    const db = sqliteD1();
    const r2 = fakeR2({ failPutOn: 'community/s3/b.json' });
    const files = [file('s3'), { key: 'community/s3/b.json', body: '{}' }];
    const out = await persistSubmission({ r2, db }, { files, submission: row('s3'), adminToken: token('s3') });
    expect(out).toMatchObject({ ok: false, step: 'store_file', cleanup: 'deleted 2 file(s)' });
    expect(out.ok === false && out.detail).toContain('community/s3/b.json: R2 put failed');
    expect(r2.objects.size).toBe(0);
    expect(await counts(db)).toEqual({ submissions: 0, tokens: 0 });
  });

  it('treats a short write as a failure', async () => {
    const db = sqliteD1();
    const r2 = fakeR2({ shortWriteOn: 'community/s4/f.geojson' });
    const out = await persistSubmission({ r2, db }, { files: [file('s4')], submission: row('s4'), adminToken: token('s4') });
    expect(out).toMatchObject({ ok: false, step: 'verify_file' });
    expect(out.ok === false && out.detail).toContain('stored 6 of 7 bytes');
    expect(await counts(db)).toEqual({ submissions: 0, tokens: 0 });
  });

  it('reports a failed cleanup instead of hiding it', async () => {
    const db = sqliteD1();
    const r2 = fakeR2({ failDelete: true });
    const out = await persistSubmission({ r2, db }, { files: [file('s5')], submission: row('s5'), adminToken: token('nope') });
    expect(out).toMatchObject({ ok: false, step: 'write_rows' });
    expect(out.ok === false && out.cleanup).toMatch(/cleanup failed: R2 delete failed/);
  });

  it('writes extra rows (collect publish) in the same transaction', async () => {
    const db = sqliteD1();
    const r2 = fakeR2();
    const bad = (d: D1Database) => [d.prepare('INSERT INTO no_such_table VALUES (1)')];
    const out = await persistSubmission({ r2, db }, { files: [file('s6')], submission: row('s6'), adminToken: token('s6'), extra: bad });
    expect(out).toMatchObject({ ok: false, step: 'write_rows' });
    expect(await counts(db)).toEqual({ submissions: 0, tokens: 0 }); // rolled back with them
  });

  it('keeps the files when the batch reports an error but actually committed', async () => {
    // e.g. the connection drops after D1 commits: deleting the files here would
    // recreate the orphan (rows without their file) this module exists to stop.
    const db = sqliteD1();
    const committedThenFailed = {
      prepare: db.prepare.bind(db),
      batch: async (stmts: D1PreparedStatement[]) => { await db.batch(stmts); throw new Error('Network connection lost'); },
    } as unknown as ReturnType<typeof sqliteD1>;
    const r2 = fakeR2();
    const out = await persistSubmission({ r2, db: committedThenFailed }, { files: [file('s7')], submission: row('s7'), adminToken: token('s7') });
    expect(out).toMatchObject({ ok: true, warning: expect.stringMatching(/committed.*Network connection lost/) });
    expect(r2.objects.size).toBe(1);
    expect(await counts(db)).toEqual({ submissions: 1, tokens: 1 });
  });

  it('keeps the files if it cannot tell whether the rows were written', async () => {
    const db = sqliteD1();
    const unreachable = {
      prepare: () => { throw new Error('D1 unavailable'); },
      batch: async () => { throw new Error('D1 unavailable'); },
    } as unknown as ReturnType<typeof sqliteD1>;
    const r2 = fakeR2();
    const out = await persistSubmission({ r2, db: unreachable }, { files: [file('s8')], submission: row('s8'), adminToken: token('s8') });
    expect(out).toMatchObject({ ok: false, step: 'write_rows' });
    expect(out.ok === false && out.cleanup).toMatch(/kept 1 file\(s\).*could not check/);
    expect(r2.objects.size).toBe(1);
  });
});
