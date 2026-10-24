import { it, expect } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
it('applies migrations and round-trips a row', async () => {
  const db = sqliteD1();
  await db.prepare('INSERT INTO collect_attempts (event, outcome) VALUES (?, ?)').bind('create', 'ok').run();
  expect(await db.prepare('SELECT COUNT(*) n FROM collect_attempts').first()).toEqual({ n: 1 });
});

// D1 enforces foreign keys and runs batch() as one ordered transaction; the
// helper must too, or tests can't catch partial-write bugs (Oct 2026: a token
// row raced its submission row and a contributor's upload was lost).
const SUB = `INSERT INTO submissions (id, created_at, status, name, category, license, attribution, source_url,
  is_original, format, bytes, ip_hash, r2_key) VALUES (?, '2026-01-01', 'pending', 'n', 'c', 'CC0-1.0', 'a', 'u', 0, 'geojson', 1, 'ip', 'k')`;
const TOK = `INSERT INTO submission_tokens (id, submission_id, token_prefix, token_hash, permission, created_at)
  VALUES (?, ?, 'adm_xxxx', 'h', 'admin', '2026-01-01')`;

it('enforces foreign keys like D1', async () => {
  const db = sqliteD1();
  await expect(db.prepare(TOK).bind('t1', 'missing').run()).rejects.toThrow(/FOREIGN KEY/i);
});

it('batch() runs in order as one transaction', async () => {
  const db = sqliteD1();
  await db.batch([db.prepare(SUB).bind('s1'), db.prepare(TOK).bind('t1', 's1')]);
  expect(await db.prepare('SELECT COUNT(*) n FROM submission_tokens').first()).toEqual({ n: 1 });
});

it('batch() rolls back every statement when one fails', async () => {
  const db = sqliteD1();
  await expect(db.batch([db.prepare(SUB).bind('s2'), db.prepare(TOK).bind('t2', 'missing')])).rejects.toThrow();
  expect(await db.prepare('SELECT COUNT(*) n FROM submissions').first()).toEqual({ n: 0 });
});
