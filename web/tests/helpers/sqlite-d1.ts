// A real SQLite database built from web/migrations, with a small D1-shaped
// adapter, so D1 queries are tested as SQL rather than against a hand-written
// fake. node:sqlite comes through require: Vite drops the node: prefix on an
// import.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

type Stmt = { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown; run(...a: unknown[]): unknown };
export type SqliteDb = { exec(sql: string): void; prepare(sql: string): Stmt };

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

/** In-memory SQLite with every migration applied, in order. */
export function migratedDb(): SqliteDb {
  const db: SqliteDb = new DatabaseSync(':memory:');
  const dir = resolve(__dirname, '../../migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(resolve(dir, f), 'utf8'));
  return db;
}

/** The D1 surface our helpers use (prepare/bind/first/all/run), counting statements. */
export function asD1(db: SqliteDb) {
  const d1 = {
    statements: 0,
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = db.prepare(sql);
      return {
        bind(...a: unknown[]) { args = a; return this; },
        async first() { d1.statements++; return (stmt.get(...args) as unknown) ?? null; },
        async all() { d1.statements++; return { results: stmt.all(...args) }; },
        async run() { d1.statements++; const r = stmt.run(...args) as { changes?: number | bigint }; return { success: true, meta: { changes: Number(r?.changes ?? 0) } }; },
      };
    },
  };
  return d1;
}
