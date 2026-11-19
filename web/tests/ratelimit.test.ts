import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '../functions/lib/ratelimit';
import { asD1, migratedDb } from './helpers/sqlite-d1';

// A real SQLite database from the migrations: the limiter is SQL (an atomic
// upsert), so it is tested as SQL.
type Row = { hour_window_start: string; hour_count: number; day_window_start: string; day_count: number };
function fakeD1() {
  const sql = migratedDb();
  const rows = { get: (k: string) => sql.prepare('SELECT * FROM rate_limits WHERE ip_hash = ?').get(k) as Row | undefined };
  return Object.assign(asD1(sql), { rows });
}
const at = (iso: string) => () => new Date(iso);

describe('checkRateLimit', () => {
  it('accepts the first call and seeds a row', async () => {
    const db = fakeD1();
    const r = await checkRateLimit(db as never, 'iphash1', at('2026-05-20T10:00:00.000Z'));
    expect(r.ok).toBe(true);
    expect(db.rows.get('iphash1')?.hour_count).toBe(1);
    expect(db.rows.get('iphash1')?.day_count).toBe(1);
  });

  it('accepts up to 5 calls in the same hour', async () => {
    const db = fakeD1();
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(db as never, 'iphash1', at(`2026-05-20T10:0${i}:00.000Z`));
      expect(r.ok).toBe(true);
    }
    expect(db.rows.get('iphash1')?.hour_count).toBe(5);
  });

  it('rejects the 6th call within the hour with retryAfter', async () => {
    const db = fakeD1();
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(db as never, 'iphash1', at('2026-05-20T10:00:00.000Z'));
    }
    const r = await checkRateLimit(db as never, 'iphash1', at('2026-05-20T10:30:00.000Z'));
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it('resets the hour window after 60+ minutes', async () => {
    const db = fakeD1();
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(db as never, 'iphash1', at('2026-05-20T10:00:00.000Z'));
    }
    const r = await checkRateLimit(db as never, 'iphash1', at('2026-05-20T11:01:00.000Z'));
    expect(r.ok).toBe(true);
    expect(db.rows.get('iphash1')?.hour_count).toBe(1);
    expect(db.rows.get('iphash1')?.day_count).toBe(6);
  });

  it('rejects the 21st call within a day even when hours roll', async () => {
    const db = fakeD1();
    for (let h = 10; h < 14; h++) {
      for (let i = 0; i < 5; i++) {
        const t = `2026-05-20T${h.toString().padStart(2, '0')}:0${i}:00.000Z`;
        await checkRateLimit(db as never, 'iphash1', at(t));
      }
    }
    expect(db.rows.get('iphash1')?.day_count).toBe(20);
    const r = await checkRateLimit(db as never, 'iphash1', at('2026-05-20T14:30:00.000Z'));
    expect(r.ok).toBe(false);
  });

  it('resets the day window after 24+ hours', async () => {
    const db = fakeD1();
    for (let h = 10; h < 14; h++) {
      for (let i = 0; i < 5; i++) {
        const t = `2026-05-20T${h.toString().padStart(2, '0')}:0${i}:00.000Z`;
        await checkRateLimit(db as never, 'iphash1', at(t));
      }
    }
    const r = await checkRateLimit(db as never, 'iphash1', at('2026-05-21T15:00:00.000Z'));
    expect(r.ok).toBe(true);
    expect(db.rows.get('iphash1')?.hour_count).toBe(1);
    expect(db.rows.get('iphash1')?.day_count).toBe(1);
  });

  it('keeps per-IP counters separate', async () => {
    const db = fakeD1();
    for (let i = 0; i < 5; i++) await checkRateLimit(db as never, 'A', at('2026-05-20T10:00:00.000Z'));
    const r = await checkRateLimit(db as never, 'B', at('2026-05-20T10:00:00.000Z'));
    expect(r.ok).toBe(true);
  });
});

describe('checkRateLimit under a parallel burst', () => {
  it('lets exactly 5 of 12 simultaneous first submissions through', async () => {
    const db = fakeD1();
    const now = at('2026-05-20T10:00:00.000Z');
    const results = await Promise.all(Array.from({ length: 12 }, () => checkRateLimit(db as never, 'burst', now)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });
});
