import { describe, it, expect } from 'vitest';
import {
  pickAffordance,
  rankColumns,
  DISPLAY_CAP,
  type ColumnStats,
} from '../src/filter-schema';

function col(overrides: Partial<ColumnStats> = {}): ColumnStats {
  return {
    name: 'x',
    type: 'string',
    distinct: 10,
    nullFrac: 0,
    ...overrides,
  };
}

describe('pickAffordance — drops', () => {
  it('drops geometry type', () => {
    expect(pickAffordance(col({ type: 'geometry' }), 100).kind).toBe('drop');
  });

  it('drops blob type', () => {
    expect(pickAffordance(col({ type: 'blob' }), 100).kind).toBe('drop');
  });

  it('drops columns named like geometry (geom, geometry, shape, wkb, wkt)', () => {
    for (const name of ['geom', 'geometry', 'shape', 'wkb', 'wkt', 'WKB']) {
      expect(pickAffordance(col({ name, type: 'string' }), 100).kind).toBe('drop');
    }
  });

  it('drops distinct=1 (all-same column)', () => {
    expect(pickAffordance(col({ distinct: 1 }), 100)).toMatchObject({
      kind: 'drop',
      reason: 'all-same',
    });
  });

  it('drops mostly-null columns (>95%)', () => {
    expect(pickAffordance(col({ nullFrac: 0.97 }), 100).kind).toBe('drop');
  });

  it('drops id-named columns (id, fid, objectid, gid, uuid, hash, geohash)', () => {
    for (const name of ['id', 'fid', 'OBJECTID', 'gid', 'uuid', 'hash', 'geohash']) {
      expect(pickAffordance(col({ name }), 1000).kind).toBe('drop');
    }
  });

  it('drops *_id columns (foreign keys / row keys)', () => {
    // Wider code/name collapsing — stcode11, state_lgd, etc. — is handled at
    // build time by the column-equivalence detection (see
    // scripts/build_filter_stats.py); the resulting non-canonical members are
    // filtered out in map.ts. The affordance picker only handles obvious
    // id-suffixed columns that don't depend on data inspection.
    for (const name of ['foo_id', 'parent_id', 'OBJECTID', 'fid']) {
      expect(pickAffordance(col({ name }), 1000).kind).toBe('drop');
    }
  });

  it('drops high-uniqueness int columns on large tables (looks like a row key)', () => {
    expect(
      pickAffordance(col({ name: 'row_no', type: 'int', distinct: 1000 }), 1000),
    ).toMatchObject({ kind: 'drop', reason: 'all-unique' });
  });

  it('keeps high-uniqueness STRING columns — they are the search target', () => {
    expect(
      pickAffordance(
        col({ name: 'village_name', type: 'string', distinct: 950 }),
        1000,
      ).kind,
    ).not.toBe('drop');
  });

  it('keeps high-uniqueness columns on tiny tables (BDA_jurisdiction-style)', () => {
    expect(
      pickAffordance(col({ name: 'name', type: 'string', distinct: 5 }), 5).kind,
    ).not.toBe('drop');
  });
});

describe('pickAffordance — boolean', () => {
  it('picks boolean for type=bool', () => {
    expect(pickAffordance(col({ type: 'bool', distinct: 2 }), 100).kind).toBe('boolean');
  });

  it('picks boolean for distinct=2 with {0,1} values', () => {
    expect(
      pickAffordance(
        col({
          type: 'int',
          distinct: 2,
          topValues: [{ v: 0, n: 50 }, { v: 1, n: 50 }],
        }),
        100,
      ).kind,
    ).toBe('boolean');
  });

  it('picks boolean for distinct=2 with {true,false} values', () => {
    expect(
      pickAffordance(
        col({
          type: 'string',
          distinct: 2,
          topValues: [{ v: 'true', n: 50 }, { v: 'false', n: 50 }],
        }),
        100,
      ).kind,
    ).toBe('boolean');
  });

  it('picks boolean for distinct=2 with {yes,no} values (case-insensitive)', () => {
    expect(
      pickAffordance(
        col({
          type: 'string',
          distinct: 2,
          topValues: [{ v: 'Yes', n: 50 }, { v: 'NO', n: 50 }],
        }),
        100,
      ).kind,
    ).toBe('boolean');
  });

  it('keeps distinct=2 with non-bool values as a facet (e.g. zone names)', () => {
    expect(
      pickAffordance(
        col({
          type: 'string',
          distinct: 2,
          topValues: [{ v: 'Royapuram', n: 50 }, { v: 'Adyar', n: 50 }],
        }),
        100,
      ).kind,
    ).toBe('facet');
  });
});

describe('pickAffordance — categorical', () => {
  it('picks facet for string distinct=10', () => {
    expect(pickAffordance(col({ type: 'string', distinct: 10 }), 1000).kind).toBe('facet');
  });

  it('picks facet for low-cardinality numeric (zone numbers 1–6)', () => {
    expect(
      pickAffordance(col({ name: 'zone', type: 'int', distinct: 6 }), 200).kind,
    ).toBe('facet');
  });

  it('picks searchable for string distinct=200 (mid-cardinality)', () => {
    const a = pickAffordance(col({ type: 'string', distinct: 200 }), 1000);
    expect(a.kind).toBe('searchable');
  });

  it('picks search for string distinct=5000 (high-cardinality)', () => {
    expect(pickAffordance(col({ type: 'string', distinct: 5000 }), 10000).kind).toBe('search');
  });

  it('attaches topValues to a facet affordance', () => {
    const a = pickAffordance(
      col({
        type: 'string',
        distinct: 3,
        topValues: [{ v: 'A', n: 5 }, { v: 'B', n: 3 }, { v: 'C', n: 2 }],
      }),
      10,
    );
    expect(a.kind).toBe('facet');
    if (a.kind === 'facet') expect(a.values).toHaveLength(3);
  });
});

describe('pickAffordance — numeric range', () => {
  it('picks range for int distinct=1000 with min/max', () => {
    const a = pickAffordance(
      col({ name: 'area_sqkm', type: 'float', distinct: 1000, min: 0.2, max: 12.4 }),
      1000,
    );
    expect(a).toMatchObject({ kind: 'range', min: 0.2, max: 12.4 });
  });

  it('falls back to facet/searchable when numeric lacks min/max', () => {
    const a = pickAffordance(
      col({ name: 'val', type: 'int', distinct: 200 }),
      1000,
    );
    expect(a.kind).toBe('searchable');
  });
});

describe('rankColumns', () => {
  it('filters out drop affordances', () => {
    const cols = [
      col({ name: 'id', type: 'int', distinct: 1000 }),
      col({ name: 'zone', type: 'string', distinct: 6 }),
    ];
    const out = rankColumns(cols, 1000);
    expect(out.map((c) => c.name)).toEqual(['zone']);
  });

  it('ranks facets above range above searchable above search', () => {
    const cols = [
      col({ name: 'searchcol', type: 'string', distinct: 5000 }),
      col({ name: 'facetcol', type: 'string', distinct: 8 }),
      col({ name: 'rangecol', type: 'float', distinct: 500, min: 0, max: 100 }),
      col({ name: 'searchablecol', type: 'string', distinct: 200 }),
    ];
    expect(rankColumns(cols, 10000).map((c) => c.name)).toEqual([
      'facetcol',
      'rangecol',
      'searchablecol',
      'searchcol',
    ]);
  });

  it('prefers lower-null columns within the same affordance kind', () => {
    const out = rankColumns(
      [
        col({ name: 'sparse', distinct: 10, nullFrac: 0.5 }),
        col({ name: 'dense', distinct: 10, nullFrac: 0.05 }),
      ],
      1000,
    );
    expect(out.map((c) => c.name)).toEqual(['dense', 'sparse']);
  });

  it(`caps to ${DISPLAY_CAP} columns`, () => {
    const cols = Array.from({ length: 12 }, (_, i) =>
      col({ name: `c${i}`, distinct: 10 }),
    );
    expect(rankColumns(cols, 100)).toHaveLength(DISPLAY_CAP);
  });
});
