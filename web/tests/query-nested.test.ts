import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getSchema, query, QueryInputError, type GroupByResult } from '../functions/lib/parquet-query';

// Fixture (duckdb): id VARCHAR | names STRUCT(primary VARCHAR) | tags VARCHAR[] | category VARCHAR | score DOUBLE
//   a {Alpha} [x,y] shop 1.5 / b {Beta} [y] shop 2.0 / c {NULL} [] bank 3.5 / d {Delta} NULL bank NULL
// The flat parquet tree also holds `primary`, `list`, `element`: those are
// not columns. Overture places (4.4M rows) listed 97 such entries for 19 columns.
const buf = readFileSync(new URL('./fixtures/nested-cols.parquet', import.meta.url));
const file = {
  byteLength: buf.byteLength,
  slice: async (start: number, end?: number) =>
    buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + (end ?? buf.byteLength)) as ArrayBuffer,
};

describe('nested parquet columns', () => {
  it('schema lists top-level columns only and marks nested ones', async () => {
    const s = await getSchema(file);
    expect(s.columns.map((c) => c.name)).toEqual(['id', 'names', 'tags', 'category', 'score']);
    const byName = Object.fromEntries(s.columns.map((c) => [c.name, c]));
    expect(byName.names.type).toBe('nested');
    expect(byName.tags.type).toBe('nested');
    expect(byName.names.distinct_values).toBeUndefined(); // no "[object Object]" samples
    expect(byName.category.distinct_values).toEqual(['bank', 'shop']);
  });

  it('rejects where and group_by on a nested column with a 400-class error', async () => {
    await expect(query(file, { where: { names: 'Alpha' } })).rejects.toThrow(QueryInputError);
    await expect(query(file, { groupBy: 'tags' })).rejects.toThrow(/nested/);
  });

  it('does not treat a struct child name as a column', async () => {
    await expect(query(file, { groupBy: 'primary' })).rejects.toThrow(/not found/);
  });

  it('still groups and filters on flat columns', async () => {
    const g = (await query(file, { groupBy: 'category' })) as GroupByResult;
    expect(g.counts).toEqual({ shop: 2, bank: 2 });
  });
});
