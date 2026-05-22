import { describe, it, expect } from 'vitest';
import {
  buildWhereSQL,
  buildMaplibreFilter,
  type ActiveFilter,
} from '../src/filter-where';

describe('buildWhereSQL — empty', () => {
  it('returns empty string for no filters', () => {
    expect(buildWhereSQL([])).toBe('');
  });

  it('returns empty string when every filter is a no-op', () => {
    expect(
      buildWhereSQL([
        { col: 'zone', kind: 'in', values: [] },
        { col: 'q', kind: 'search', q: '   ' },
        { col: 'area', kind: 'range' },
      ]),
    ).toBe('');
  });
});

describe('buildWhereSQL — IN', () => {
  it('quotes string values, omits quotes on numbers', () => {
    expect(buildWhereSQL([{ col: 'zone', kind: 'in', values: ['Adyar', 1] }])).toBe(
      `WHERE "zone" IN ('Adyar', 1)`,
    );
  });

  it('escapes single quotes inside string values', () => {
    expect(buildWhereSQL([{ col: 'ward', kind: 'in', values: [`O'Reilly`] }])).toBe(
      `WHERE "ward" IN ('O''Reilly')`,
    );
  });

  it('escapes double quotes inside column names', () => {
    expect(buildWhereSQL([{ col: `weird"col`, kind: 'in', values: ['a'] }])).toBe(
      `WHERE "weird""col" IN ('a')`,
    );
  });

  it('coerces BigInt to Number-string (parquet COUNT outputs)', () => {
    const f: ActiveFilter = { col: 'n', kind: 'in', values: [42n as unknown as number] };
    expect(buildWhereSQL([f])).toBe(`WHERE "n" IN (42)`);
  });
});

describe('buildWhereSQL — range', () => {
  it('emits both bounds with AND', () => {
    expect(buildWhereSQL([{ col: 'area', kind: 'range', min: 5, max: 10 }])).toBe(
      `WHERE "area" >= 5 AND "area" <= 10`,
    );
  });

  it('emits only the lower bound when max is missing', () => {
    expect(buildWhereSQL([{ col: 'area', kind: 'range', min: 5 }])).toBe(
      `WHERE "area" >= 5`,
    );
  });

  it('emits only the upper bound when min is missing', () => {
    expect(buildWhereSQL([{ col: 'area', kind: 'range', max: 10 }])).toBe(
      `WHERE "area" <= 10`,
    );
  });
});

describe('buildWhereSQL — search ILIKE', () => {
  it('wraps the query in %…% with explicit ESCAPE clause', () => {
    expect(buildWhereSQL([{ col: 'name', kind: 'search', q: 'adyar' }])).toBe(
      `WHERE "name" ILIKE '%adyar%' ESCAPE '\\'`,
    );
  });

  it('escapes wildcard chars in the query', () => {
    expect(buildWhereSQL([{ col: 'name', kind: 'search', q: '50%' }])).toBe(
      `WHERE "name" ILIKE '%50\\%%' ESCAPE '\\'`,
    );
  });

  it('escapes underscores in the query', () => {
    expect(buildWhereSQL([{ col: 'name', kind: 'search', q: 'a_b' }])).toBe(
      `WHERE "name" ILIKE '%a\\_b%' ESCAPE '\\'`,
    );
  });
});

describe('buildWhereSQL — bool', () => {
  it('emits TRUE for true and FALSE for false', () => {
    expect(buildWhereSQL([{ col: 'approved', kind: 'bool', v: true }])).toBe(
      `WHERE "approved" = TRUE`,
    );
    expect(buildWhereSQL([{ col: 'approved', kind: 'bool', v: false }])).toBe(
      `WHERE "approved" = FALSE`,
    );
  });
});

describe('buildWhereSQL — composition', () => {
  it('ANDs multiple filters together', () => {
    expect(
      buildWhereSQL([
        { col: 'zone', kind: 'in', values: ['Adyar'] },
        { col: 'area', kind: 'range', min: 1, max: 5 },
        { col: 'name', kind: 'search', q: 'a' },
      ]),
    ).toBe(
      `WHERE "zone" IN ('Adyar') AND "area" >= 1 AND "area" <= 5 AND "name" ILIKE '%a%' ESCAPE '\\'`,
    );
  });
});

describe('buildMaplibreFilter — empty + skipped kinds', () => {
  it('returns null for an empty filter list', () => {
    expect(buildMaplibreFilter([])).toBeNull();
  });

  it('returns null when only a search filter is active', () => {
    expect(buildMaplibreFilter([{ col: 'name', kind: 'search', q: 'a' }])).toBeNull();
  });

  it('skips IN filters with no values', () => {
    expect(buildMaplibreFilter([{ col: 'zone', kind: 'in', values: [] }])).toBeNull();
  });
});

describe('buildMaplibreFilter — single filter', () => {
  it("wraps IN values in ['literal', ...]", () => {
    expect(
      buildMaplibreFilter([{ col: 'zone', kind: 'in', values: ['Adyar', 'Royapuram'] }]),
    ).toEqual(['in', ['get', 'zone'], ['literal', ['Adyar', 'Royapuram']]]);
  });

  it('emits a bare comparison when range has one bound', () => {
    expect(buildMaplibreFilter([{ col: 'area', kind: 'range', min: 5 }])).toEqual([
      '>=', ['get', 'area'], 5,
    ]);
  });

  it("wraps a two-bound range in ['all', …]", () => {
    expect(buildMaplibreFilter([{ col: 'area', kind: 'range', min: 5, max: 10 }])).toEqual([
      'all',
      ['>=', ['get', 'area'], 5],
      ['<=', ['get', 'area'], 10],
    ]);
  });

  it('emits ==  for bool', () => {
    expect(buildMaplibreFilter([{ col: 'approved', kind: 'bool', v: true }])).toEqual([
      '==', ['get', 'approved'], true,
    ]);
  });
});

describe('buildMaplibreFilter — composition', () => {
  it("ANDs multiple filters via ['all', …]", () => {
    expect(
      buildMaplibreFilter([
        { col: 'zone', kind: 'in', values: ['Adyar'] },
        { col: 'approved', kind: 'bool', v: true },
      ]),
    ).toEqual([
      'all',
      ['in', ['get', 'zone'], ['literal', ['Adyar']]],
      ['==', ['get', 'approved'], true],
    ]);
  });
});
