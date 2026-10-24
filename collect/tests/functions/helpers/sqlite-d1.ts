// A real SQLite database behind the slice of the D1 API the handlers use
// (prepare → bind → run / first / all), with every web/migrations file applied.
// Lets handler tests run against the actual schema instead of a hand-written
// fake that drifts from it. node:sqlite is built into Node 22 and enforces
// foreign keys by default, as D1 does.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as DB } from 'node:sqlite';

// Vite rewrites 'node:sqlite' to a bare 'sqlite' id it can't resolve, so load
// the builtin through Node's own require.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DB };

const MIGRATIONS = join(__dirname, '../../../../web/migrations');

export function sqliteD1(): D1Database & { raw: DB } {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  const norm = (v: unknown): unknown => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind(...a: unknown[]) { args = a.map(norm); return stmt; },
      async run() { const r = raw.prepare(sql).run(...(args as never[])); return { success: true, meta: { changes: Number(r.changes) } }; },
      async first<T>() { return (raw.prepare(sql).get(...(args as never[])) as T) ?? null; },
      async all<T>() { return { success: true, results: raw.prepare(sql).all(...(args as never[])) as T[] }; },
    };
    return stmt;
  };
  // D1 batch(): statements run in order inside one transaction; any failure
  // rolls them all back and rejects.
  const batch = async (stmts: Array<{ run: () => Promise<unknown> }>) => {
    raw.exec('BEGIN');
    try {
      const out = [];
      for (const st of stmts) out.push(await st.run());
      raw.exec('COMMIT');
      return out;
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  };
  return { prepare, batch, raw } as unknown as D1Database & { raw: DB };
}
