// Every large layer's value index (scripts/bake_value_index.py) must exist and name the
// parquet the catalog names now: a stale one is ignored at run time (the query scans and
// is slow again), so a refreshed layer must be re-indexed. Run the bake to fix this test.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8');
const catalog = JSON.parse(read('catalog.json')) as { layers: Array<{ id: string; parquet?: { url: string; bytes: number | null } }> };
const BAKE = read('scripts/bake_value_index.py');
const MIN_ROWS = Number(/^MIN_ROWS = ([\d_]+)/m.exec(BAKE)![1].replace(/_/g, ''));
const MAX_VALUES = Number(/^MAX_VALUES = ([\d_]+)/m.exec(BAKE)![1].replace(/_/g, ''));

type Stats = {
  row_count: number; parquet?: { url: string; bytes: number | null };
  columns: Array<{ name: string; distinct: number }>;
  schema?: Array<{ name: string; type?: string; converted_type?: string; nested?: boolean }>;
};

/** The bake's rule (indexable_columns), read from each layer's stats file. */
function indexable(s: Stats): string[] {
  if (s.row_count < MIN_ROWS) return [];
  const distinct = new Map(s.columns.map((c) => [c.name, c.distinct]));
  return (s.schema ?? []).filter((c) => c.type === 'BYTE_ARRAY' && ['UTF8', 'STRING'].includes(c.converted_type ?? '') && !c.nested
    && (distinct.get(c.name) ?? -1) >= 1 && (distinct.get(c.name) ?? -1) <= MAX_VALUES).map((c) => c.name);
}

describe('value indexes are fresh', () => {
  const byId = new Map(catalog.layers.map((l) => [l.id, l]));
  const due = catalog.layers.filter((l) => l.parquet?.url && !l.id.startsWith('c_')).flatMap((l) => {
    const p = `web/public/api-data/filter-stats/${l.id}.json`;
    if (!existsSync(new URL(p, ROOT))) return [];
    const s = JSON.parse(read(p)) as Stats;
    return indexable(s).length ? [{ id: l.id, cols: indexable(s) }] : [];
  });

  it('the rule finds the large layers (Overture among them)', () => {
    expect(MIN_ROWS).toBe(200_000);
    expect(MAX_VALUES).toBe(1000);
    expect(due.map((d) => d.id)).toContain('overture_places_india');
  });

  it('every large layer has an index baked from the parquet the catalog names, with its columns (run scripts/bake_value_index.py)', () => {
    const bad: string[] = [];
    for (const { id, cols } of due) {
      const p = `web/public/api-data/value-index/${id}.json`;
      if (!existsSync(new URL(p, ROOT))) { bad.push(`${id}: missing`); continue; }
      const f = JSON.parse(read(p)) as { parquet: unknown; rows?: number; columns: Record<string, unknown> };
      if (typeof f.rows !== 'number') bad.push(`${id}: no row count`);
      const layer = byId.get(id)!;
      if (JSON.stringify(f.parquet) !== JSON.stringify({ url: layer.parquet!.url, bytes: layer.parquet!.bytes ?? null })) bad.push(`${id}: stale`);
      const missing = cols.filter((c) => !(c in f.columns));
      if (missing.length) bad.push(`${id}: no ${missing.join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  it('no index for a layer that is no longer in the catalog', () => {
    const files = readdirSync(new URL('web/public/api-data/value-index/', ROOT)).map((f) => f.replace(/\.json$/, ''));
    expect(files.filter((id) => !byId.has(id))).toEqual([]);
  });
});
