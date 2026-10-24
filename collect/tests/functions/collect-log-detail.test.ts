// The collect attempt log keeps working (base columns, with a warning) when
// migration 0013 has not run yet, and records the detail columns when it has.
import { it, expect, vi, afterEach } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import { logCollectAttempt } from '../../functions/lib/collect-log';

afterEach(() => vi.restoreAllMocks());
const row = { event: 'publish' as const, outcome: 'rejected' as const, gate: 'persist', collection_id: 'c1', attempt_id: 'att_1', step: 'write_rows', detail: 'boom' };

it('records the detail columns', async () => {
  const db = sqliteD1();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await logCollectAttempt(db, row);
  expect(await db.prepare('SELECT gate, attempt_id, step, detail FROM collect_attempts').first())
    .toEqual({ gate: 'persist', attempt_id: 'att_1', step: 'write_rows', detail: 'boom' });
});

it('falls back to the base columns, and says so, before migration 0013', async () => {
  const db = sqliteD1();
  db.raw.exec('DROP TABLE collect_attempts');
  db.raw.exec(`CREATE TABLE collect_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')),
    event TEXT NOT NULL, outcome TEXT NOT NULL, gate TEXT, reason TEXT, collection_id TEXT, ip_hash TEXT)`);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await logCollectAttempt(db, row);
  expect(await db.prepare('SELECT gate, collection_id FROM collect_attempts').first()).toEqual({ gate: 'persist', collection_id: 'c1' });
  expect(String(err.mock.calls[0][0])).toMatch(/collect_attempts logging degraded/);
});
