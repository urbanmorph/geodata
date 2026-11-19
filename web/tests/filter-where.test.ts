import { describe, it, expect } from 'vitest';
import {
  whereClause,
  buildMaplibreFilter,
  filterColumnsInTiles,
  typeaheadSQL,
  filterSummary,
  matchCountText,
  resolveStateCodes,
  type ActiveFilter,
} from '../src/filter-where';

// The "Filtered: ..." pill over the map says what is filtered once the panel closes.
describe('filterSummary: the active filter in a few words', () => {
  it('one value reads as column = value', () => {
    expect(filterSummary([{ col: 'source', kind: 'in', values: ['GatiShakti'] }])).toBe('source = GatiShakti');
  });
  it('two values are listed, more are counted', () => {
    expect(filterSummary([{ col: 'zone', kind: 'in', values: ['Adyar', 'Anna Nagar'] }])).toBe('zone = Adyar, Anna Nagar');
    expect(filterSummary([{ col: 'zone', kind: 'in', values: ['A', 'B', 'C'] }])).toBe('zone: 3 values');
  });
  it('ranges, searches and yes/no', () => {
    expect(filterSummary([{ col: 'pop', kind: 'range', min: 10, max: 20 }])).toBe('pop 10 to 20');
    expect(filterSummary([{ col: 'pop', kind: 'range', min: 10 }])).toBe('pop ≥ 10');
    expect(filterSummary([{ col: 'pop', kind: 'range', max: 20 }])).toBe('pop ≤ 20');
    expect(filterSummary([{ col: 'name', kind: 'search', q: ' ganga ' }])).toBe('name contains "ganga"');
    expect(filterSummary([{ col: 'active', kind: 'bool', v: false }])).toBe('active = no');
  });
  it('several filters: the first, then how many more', () => {
    expect(filterSummary([
      { col: 'source', kind: 'in', values: ['GatiShakti'] },
      { col: 'state', kind: 'in', values: ['Goa'] },
      { col: 'pop', kind: 'range', min: 1 },
    ])).toBe('source = GatiShakti + 2 more');
  });
  it('nothing active is empty', () => {
    expect(filterSummary([])).toBe('');
  });
});

describe('matchCountText: "9,386 of 9,483"', () => {
  it('formats both numbers the Indian way', () => {
    expect(matchCountText(9386, 9483)).toBe('9,386 of 9,483');
    expect(matchCountText(123456, 584000)).toBe('1,23,456 of 5,84,000');
  });
  it('without a total, just the count', () => {
    expect(matchCountText(12, 0)).toBe('12');
  });
});

describe('filterColumnsInTiles: whether the map can draw the filter', () => {
  const f: ActiveFilter[] = [{ col: 'zone', kind: 'in', values: ['Adyar'] }, { col: 'q', kind: 'search', q: 'x' }];
  it('true when every filtered column is a tile property', () => {
    expect(filterColumnsInTiles(f, new Set(['zone', 'q', 'other']))).toBe(true);
  });
  it('false when a filtered column is not in the tiles', () => {
    expect(filterColumnsInTiles(f, new Set(['zone']))).toBe(false);
  });
  it('true while no tile has loaded (unknown), so the filter is kept', () => {
    expect(filterColumnsInTiles(f, null)).toBe(true);
  });
  // Tiles now carry the panel's low-cardinality columns (scripts/rebake_tiles.py,
  // build_filter_stats.tile_filter_columns): e.g. state_finance's State_LGD, a
  // facet once missing from its tiles. A feature omits a null property, so the
  // keys are the union over the sampled features, as map.ts tilePropertyKeys builds them.
  it('true for a facet column the rebaked tiles carry, even if some features omit it', () => {
    const feats = [{ STNAME: 'Goa' }, { STNAME: 'Kerala', State_LGD: 32 }];
    const keys = new Set(feats.flatMap((p) => Object.keys(p)));
    expect(filterColumnsInTiles([{ col: 'State_LGD', kind: 'in', values: [32] }], keys)).toBe(true);
  });
});

describe('typeaheadSQL: the search box suggestions', () => {
  it('matches % and _ literally, like the filter itself', () => {
    const sql = typeaheadSQL('https://r2/x.parquet', 'name', "50%_o'k");
    expect(sql).toContain(`"name"::VARCHAR ILIKE '%50\\%\\_o''k%' ESCAPE '\\'`);
    expect(sql).toContain(`FROM 'https://r2/x.parquet'`);
    expect(sql).toMatch(/LIMIT 8$/);
  });
});

describe('whereClause — empty', () => {
  it('returns empty string for no filters', () => {
    expect(whereClause([])).toBe('');
  });

  it('returns empty string when every filter is a no-op', () => {
    expect(
      whereClause([
        { col: 'zone', kind: 'in', values: [] },
        { col: 'q', kind: 'search', q: '   ' },
        { col: 'area', kind: 'range' },
      ]),
    ).toBe('');
  });
});

describe('whereClause — IN', () => {
  it('quotes string values, omits quotes on numbers', () => {
    expect(whereClause([{ col: 'zone', kind: 'in', values: ['Adyar', 1] }])).toBe(
      `"zone" IN ('Adyar', 1)`,
    );
  });

  it('escapes single quotes inside string values', () => {
    expect(whereClause([{ col: 'ward', kind: 'in', values: [`O'Reilly`] }])).toBe(
      `"ward" IN ('O''Reilly')`,
    );
  });

  it('escapes double quotes inside column names', () => {
    expect(whereClause([{ col: `weird"col`, kind: 'in', values: ['a'] }])).toBe(
      `"weird""col" IN ('a')`,
    );
  });

  it('coerces BigInt to Number-string (parquet COUNT outputs)', () => {
    const f: ActiveFilter = { col: 'n', kind: 'in', values: [42n as unknown as number] };
    expect(whereClause([f])).toBe(`"n" IN (42)`);
  });
});

describe('whereClause — range', () => {
  it('emits both bounds with AND', () => {
    expect(whereClause([{ col: 'area', kind: 'range', min: 5, max: 10 }])).toBe(
      `"area" >= 5 AND "area" <= 10`,
    );
  });

  it('emits only the lower bound when max is missing', () => {
    expect(whereClause([{ col: 'area', kind: 'range', min: 5 }])).toBe(
      `"area" >= 5`,
    );
  });

  it('emits only the upper bound when min is missing', () => {
    expect(whereClause([{ col: 'area', kind: 'range', max: 10 }])).toBe(
      `"area" <= 10`,
    );
  });
});

describe('whereClause — search ILIKE', () => {
  it('wraps the query in %…% with explicit ESCAPE clause', () => {
    expect(whereClause([{ col: 'name', kind: 'search', q: 'adyar' }])).toBe(
      `"name" ILIKE '%adyar%' ESCAPE '\\'`,
    );
  });

  it('escapes wildcard chars in the query', () => {
    expect(whereClause([{ col: 'name', kind: 'search', q: '50%' }])).toBe(
      `"name" ILIKE '%50\\%%' ESCAPE '\\'`,
    );
  });

  it('escapes underscores in the query', () => {
    expect(whereClause([{ col: 'name', kind: 'search', q: 'a_b' }])).toBe(
      `"name" ILIKE '%a\\_b%' ESCAPE '\\'`,
    );
  });
});

describe('whereClause — bool', () => {
  it('emits TRUE for true and FALSE for false', () => {
    expect(whereClause([{ col: 'approved', kind: 'bool', v: true }])).toBe(
      `"approved" = TRUE`,
    );
    expect(whereClause([{ col: 'approved', kind: 'bool', v: false }])).toBe(
      `"approved" = FALSE`,
    );
  });
});

describe('whereClause — composition', () => {
  it('ANDs multiple filters together', () => {
    expect(
      whereClause([
        { col: 'zone', kind: 'in', values: ['Adyar'] },
        { col: 'area', kind: 'range', min: 1, max: 5 },
        { col: 'name', kind: 'search', q: 'a' },
      ]),
    ).toBe(
      `"zone" IN ('Adyar') AND "area" >= 1 AND "area" <= 5 AND "name" ILIKE '%a%' ESCAPE '\\'`,
    );
  });
});

describe('buildMaplibreFilter — empty + skipped kinds', () => {
  it('returns null for an empty filter list', () => {
    expect(buildMaplibreFilter([])).toBeNull();
  });

  it('returns null when a search filter is empty/whitespace only', () => {
    expect(buildMaplibreFilter([{ col: 'name', kind: 'search', q: '   ' }])).toBeNull();
  });

  it('skips IN filters with no values', () => {
    expect(buildMaplibreFilter([{ col: 'zone', kind: 'in', values: [] }])).toBeNull();
  });
});

describe('buildMaplibreFilter — search (case-insensitive contains)', () => {
  it('translates a search filter to downcase + in so the match isolates on the map', () => {
    expect(
      buildMaplibreFilter([{ col: 'KGISWardName', kind: 'search', q: 'Sanjaya Nagar' }]),
    ).toEqual(['in', 'sanjaya nagar', ['downcase', ['to-string', ['get', 'KGISWardName']]]]);
  });

  it('composes a search filter with an IN filter under all', () => {
    expect(
      buildMaplibreFilter([
        { col: 'zone', kind: 'in', values: ['East'] },
        { col: 'KGISWardName', kind: 'search', q: 'Adyar' },
      ]),
    ).toEqual([
      'all',
      ['in', ['get', 'zone'], ['literal', ['East']]],
      ['in', 'adyar', ['downcase', ['to-string', ['get', 'KGISWardName']]]],
    ]);
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

// The pre-baked per-state extract is the whole state: it may stand in for the
// filter only when every picked value is a known state (else the export narrows).
describe('resolveStateCodes', () => {
  const names = new Map([['kerala', 32], ['goa', 30]]);
  const inF = (col: string, values: (string | number)[]): ActiveFilter[] => [{ kind: 'in', col, values }];
  it('maps state names and codes', () => {
    expect(resolveStateCodes(inF('stname', ['Kerala']), names)).toEqual([32]);
    expect(resolveStateCodes(inF('state_lgd', ['32', 30]), names)).toEqual([32, 30]);
  });
  it('returns [] when any value does not map, instead of dropping it', () => {
    expect(resolveStateCodes(inF('stname', ['Kerala', 'Atlantis']), names)).toEqual([]);
    expect(resolveStateCodes(inF('state', ['Atlantis']), names)).toEqual([]);
    expect(resolveStateCodes(inF('state_lgd', ['32', 'x']), names)).toEqual([]);
  });
});
