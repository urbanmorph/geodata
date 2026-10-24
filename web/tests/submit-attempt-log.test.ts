import { describe, it, expect, vi, afterEach } from 'vitest';
import { sqliteD1 } from '../../collect/tests/functions/helpers/sqlite-d1';
import { logAttempt, type AttemptRow } from '../functions/lib/submit-log';

// "Even if something happens I need to know what happened": every attempt is
// recorded with the reference shown to the contributor, the failing step, the
// exact error and timing, and a logging failure is reported, never swallowed.

const failed: AttemptRow = {
  outcome: 'rejected', gate: 'persist', reason: 'could not save your submission',
  ext: 'geojson', bytes: 14146519, ip_hash: 'ip',
  attempt_id: 'att_abc123', submission_id: null, step: 'write_rows',
  detail: 'FOREIGN KEY constraint failed', duration_ms: 1840, cleanup: 'deleted 1 file(s)',
};

afterEach(() => vi.restoreAllMocks());

describe('logAttempt', () => {
  it('records the reference, step, exact error, timing and cleanup', async () => {
    const db = sqliteD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await logAttempt(db, failed);
    const r = await db.prepare('SELECT * FROM submit_attempts').first();
    expect(r).toMatchObject({
      outcome: 'rejected', gate: 'persist', attempt_id: 'att_abc123', step: 'write_rows',
      detail: 'FOREIGN KEY constraint failed', duration_ms: 1840, cleanup: 'deleted 1 file(s)',
    });
  });

  it('prints every attempt as one structured line for the Worker logs', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await logAttempt(sqliteD1(), failed);
    const line = JSON.parse(String(out.mock.calls[0][0]));
    expect(line).toMatchObject({ event: 'submit_attempt', attempt_id: 'att_abc123', detail: 'FOREIGN KEY constraint failed' });
  });

  it('falls back to the original columns (and says so) if the migration has not run', async () => {
    const db = sqliteD1();
    db.raw.exec('DROP TABLE submit_attempts');
    db.raw.exec(`CREATE TABLE submit_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')),
      outcome TEXT NOT NULL, gate TEXT, reason TEXT, ext TEXT, bytes INTEGER, ip_hash TEXT)`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await logAttempt(db, failed);
    expect(await db.prepare('SELECT gate, reason FROM submit_attempts').first()).toEqual({ gate: 'persist', reason: failed.reason });
    expect(String(err.mock.calls[0][0])).toMatch(/submit_attempts.*degraded/i);
  });

  it('never throws, and puts the whole attempt in the error log if the database is unreachable', async () => {
    const broken = { prepare: () => { throw new Error('D1 unavailable'); } } as unknown as D1Database;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(logAttempt(broken, failed)).resolves.toBeUndefined();
    const logged = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/D1 unavailable/);
    expect(logged).toContain('att_abc123');
  });
});
