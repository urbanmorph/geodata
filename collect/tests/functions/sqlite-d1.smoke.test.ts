import { it, expect } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
it('applies migrations and round-trips a row', async () => {
  const db = sqliteD1();
  await db.prepare('INSERT INTO collect_attempts (event, outcome) VALUES (?, ?)').bind('create', 'ok').run();
  expect(await db.prepare('SELECT COUNT(*) n FROM collect_attempts').first()).toEqual({ n: 1 });
});
