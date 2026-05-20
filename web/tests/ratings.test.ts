import { describe, it, expect } from 'vitest';
import { recordRating, countRatings } from '../functions/lib/ratings';

type Row = { submission_id: string; ip_hash: string; created_at: string };

function fakeD1() {
  const rows = new Map<string, Row>();
  return {
    rows,
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) {
          args = a;
          return this;
        },
        async run() {
          if (/INSERT OR IGNORE INTO submission_ratings/.test(sql)) {
            const [submission_id, ip_hash, created_at] = args as [string, string, string];
            const key = `${submission_id}|${ip_hash}`;
            const existed = rows.has(key);
            if (!existed) rows.set(key, { submission_id, ip_hash, created_at });
            return { success: true, meta: { changes: existed ? 0 : 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          if (/SELECT COUNT\(\*\) .* FROM submission_ratings WHERE submission_id/.test(sql)) {
            const [submission_id] = args as [string];
            let n = 0;
            for (const r of rows.values()) if (r.submission_id === submission_id) n++;
            return { c: n };
          }
          return null;
        },
      };
    },
  };
}

describe('recordRating', () => {
  it('records a new rating and returns count=1', async () => {
    const db = fakeD1();
    const r = await recordRating(db as never, 'sub1', 'iphash1');
    expect(r.alreadyRated).toBe(false);
    expect(r.count).toBe(1);
    expect(db.rows.size).toBe(1);
  });

  it('returns alreadyRated=true on a repeat from the same IP', async () => {
    const db = fakeD1();
    await recordRating(db as never, 'sub1', 'iphash1');
    const r = await recordRating(db as never, 'sub1', 'iphash1');
    expect(r.alreadyRated).toBe(true);
    expect(r.count).toBe(1);
    expect(db.rows.size).toBe(1);
  });

  it('counts distinct IPs as separate ratings', async () => {
    const db = fakeD1();
    await recordRating(db as never, 'sub1', 'A');
    const r2 = await recordRating(db as never, 'sub1', 'B');
    const r3 = await recordRating(db as never, 'sub1', 'C');
    expect(r2.count).toBe(2);
    expect(r3.count).toBe(3);
  });

  it('keeps ratings scoped to the submission', async () => {
    const db = fakeD1();
    await recordRating(db as never, 'sub1', 'A');
    await recordRating(db as never, 'sub2', 'A');
    const r = await recordRating(db as never, 'sub1', 'B');
    expect(r.count).toBe(2);
  });
});

describe('countRatings', () => {
  it('returns 0 for a submission with no ratings', async () => {
    const db = fakeD1();
    expect(await countRatings(db as never, 'nope')).toBe(0);
  });

  it('returns the current count', async () => {
    const db = fakeD1();
    await recordRating(db as never, 'sub1', 'A');
    await recordRating(db as never, 'sub1', 'B');
    await recordRating(db as never, 'sub1', 'B'); // dup
    expect(await countRatings(db as never, 'sub1')).toBe(2);
  });
});
