import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db', () => ({
  query: vi.fn(),
}));

import { query } from '../src/db';
import { describeParquet } from '../src/filter-probe';

const mockQuery = vi.mocked(query);

beforeEach(() => {
  mockQuery.mockReset();
});

describe('describeParquet — SQL shape', () => {
  it('issues a DESCRIBE then a single combined aggregate sweep', async () => {
    mockQuery
      .mockResolvedValueOnce([
        { column_name: 'name', column_type: 'VARCHAR' },
        { column_name: 'area', column_type: 'DOUBLE' },
        { column_name: 'geom', column_type: 'GEOMETRY' },
      ])
      .mockResolvedValueOnce([
        {
          row_count: 100,
          distinct_name: 100, null_name: 0, min_name: 'a', max_name: 'z',
          distinct_area: 95, null_area: 0.05, min_area: '0.1', max_area: '100.5',
        },
      ]);

    await describeParquet('https://x/y.parquet');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect((mockQuery.mock.calls[0][0] as string)).toContain('DESCRIBE');
    const aggSql = mockQuery.mock.calls[1][0] as string;
    expect(aggSql).toContain('COUNT(DISTINCT "name")');
    expect(aggSql).toContain('COUNT(DISTINCT "area")');
    expect(aggSql).not.toContain('"geom"');
  });

  it('skips the combined aggregate when every column is geometry/blob', async () => {
    mockQuery.mockResolvedValueOnce([
      { column_name: 'geom', column_type: 'GEOMETRY' },
    ]).mockResolvedValueOnce([{ row_count: 7 }]);

    const r = await describeParquet('x');
    expect(r.rowCount).toBe(7);
    expect(r.columns[0]).toMatchObject({ type: 'geometry', distinct: -1 });
    // 1 DESCRIBE + 1 row_count, no aggregate sweep
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe('describeParquet — type normalisation', () => {
  it('maps DuckDB types onto the schema vocabulary', async () => {
    mockQuery
      .mockResolvedValueOnce([
        { column_name: 'c_int', column_type: 'BIGINT' },
        { column_name: 'c_flt', column_type: 'DOUBLE' },
        { column_name: 'c_str', column_type: 'VARCHAR' },
        { column_name: 'c_bool', column_type: 'BOOLEAN' },
        { column_name: 'c_dec', column_type: 'DECIMAL(18,2)' },
        { column_name: 'c_ts', column_type: 'TIMESTAMP' },
      ])
      .mockResolvedValueOnce([{
        row_count: 1,
        distinct_c_int: 1, null_c_int: 0, min_c_int: '5', max_c_int: '5',
        distinct_c_flt: 1, null_c_flt: 0, min_c_flt: '1.5', max_c_flt: '1.5',
        distinct_c_str: 1, null_c_str: 0, min_c_str: 'a', max_c_str: 'a',
        distinct_c_bool: 1, null_c_bool: 0, min_c_bool: 'true', max_c_bool: 'true',
        distinct_c_dec: 1, null_c_dec: 0, min_c_dec: '0.01', max_c_dec: '0.01',
        distinct_c_ts: 1, null_c_ts: 0, min_c_ts: '2024-01-01', max_c_ts: '2024-01-01',
      }]);

    const r = await describeParquet('x');
    const byName = Object.fromEntries(r.columns.map((c) => [c.name, c.type]));
    expect(byName).toEqual({
      c_int: 'int', c_flt: 'float', c_str: 'string',
      c_bool: 'bool', c_dec: 'float', c_ts: 'date',
    });
  });
});

describe('describeParquet — top_values', () => {
  it('fetches top_values only for columns with 2 ≤ distinct ≤ 50', async () => {
    mockQuery
      .mockResolvedValueOnce([
        { column_name: 'zone', column_type: 'VARCHAR' },
        { column_name: 'name', column_type: 'VARCHAR' }, // high-cardinality
        { column_name: 'flag', column_type: 'VARCHAR' }, // distinct == 1
      ])
      .mockResolvedValueOnce([{
        row_count: 200,
        distinct_zone: 10, null_zone: 0, min_zone: 'A', max_zone: 'Z',
        distinct_name: 200, null_name: 0, min_name: 'a', max_name: 'z',
        distinct_flag: 1, null_flag: 0, min_flag: 'x', max_flag: 'x',
      }])
      .mockResolvedValueOnce([
        { v: 'Royapuram', n: 30 },
        { v: 'Adyar', n: 25 },
      ]);

    const r = await describeParquet('x');
    expect(mockQuery).toHaveBeenCalledTimes(3);
    const zone = r.columns.find((c) => c.name === 'zone')!;
    expect(zone.topValues).toEqual([
      { v: 'Royapuram', n: 30 },
      { v: 'Adyar', n: 25 },
    ]);
    expect(r.columns.find((c) => c.name === 'name')!.topValues).toBeUndefined();
    expect(r.columns.find((c) => c.name === 'flag')!.topValues).toBeUndefined();
  });
});

describe('describeParquet — value coercion', () => {
  it('coerces numeric min/max to numbers and preserves strings for text', async () => {
    mockQuery
      .mockResolvedValueOnce([
        { column_name: 'area', column_type: 'DOUBLE' },
        { column_name: 'name', column_type: 'VARCHAR' },
      ])
      .mockResolvedValueOnce([{
        row_count: 10,
        distinct_area: 10, null_area: 0, min_area: '0.21', max_area: '12.4',
        distinct_name: 10, null_name: 0, min_name: 'a', max_name: 'z',
      }]);
    const r = await describeParquet('x');
    const area = r.columns.find((c) => c.name === 'area')!;
    expect(area.min).toBe(0.21);
    expect(area.max).toBe(12.4);
    const name = r.columns.find((c) => c.name === 'name')!;
    expect(name.min).toBe('a');
  });

  it('coerces BigInt distinct/null counts to Number', async () => {
    mockQuery
      .mockResolvedValueOnce([{ column_name: 'c', column_type: 'INTEGER' }])
      .mockResolvedValueOnce([{
        row_count: 100n,
        distinct_c: 5n, null_c: 0, min_c: '1', max_c: '5',
      }]);
    const r = await describeParquet('x');
    expect(r.rowCount).toBe(100);
    expect(r.columns[0].distinct).toBe(5);
  });
});

describe('describeParquet — identifier safety', () => {
  it('escapes embedded double quotes in column names', async () => {
    mockQuery
      .mockResolvedValueOnce([{ column_name: 'we"ird', column_type: 'VARCHAR' }])
      .mockResolvedValueOnce([{
        row_count: 1,
        distinct_we_ird: 1, null_we_ird: 0, min_we_ird: 'x', max_we_ird: 'x',
      }]);
    await describeParquet('x');
    const aggSql = mockQuery.mock.calls[1][0] as string;
    expect(aggSql).toContain('"we""ird"');
  });
});
