import { describe, it, expect } from 'vitest';
import { normaliseFC, validate, detectCRS, visitCoords, featureCollectionBounds, type FC } from '../src/validate';

describe('normaliseFC', () => {
  it('passes through a FeatureCollection', () => {
    const fc = { type: 'FeatureCollection', features: [] };
    expect(normaliseFC(fc)).toEqual(fc);
  });

  it('wraps a bare Feature into a single-element FC', () => {
    const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [77, 28] }, properties: {} };
    const fc = normaliseFC(f);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]).toBe(f);
  });

  it('wraps a bare array as features', () => {
    const arr = [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: null },
    ];
    const fc = normaliseFC(arr);
    expect(fc.features).toHaveLength(1);
  });

  it('throws on a non-object input', () => {
    expect(() => normaliseFC(null)).toThrow('not a JSON object');
    expect(() => normaliseFC(42)).toThrow();
    expect(() => normaliseFC('hi')).toThrow();
  });

  it('throws on a JSON object that is not Feature/FeatureCollection/array', () => {
    expect(() => normaliseFC({ foo: 'bar' })).toThrow('not a GeoJSON');
  });
});

describe('detectCRS', () => {
  it('returns the crs.properties.name when present', () => {
    expect(detectCRS({ crs: { properties: { name: 'urn:ogc:def:crs:EPSG::3857' } } })).toBe(
      'urn:ogc:def:crs:EPSG::3857',
    );
  });

  it('returns undefined for missing or partial crs', () => {
    expect(detectCRS({})).toBeUndefined();
    expect(detectCRS({ crs: {} })).toBeUndefined();
    expect(detectCRS(null)).toBeUndefined();
    expect(detectCRS(undefined)).toBeUndefined();
  });
});

describe('visitCoords', () => {
  it('walks Point coordinates', () => {
    const seen: Array<[number, number]> = [];
    visitCoords({ type: 'Point', coordinates: [77, 28] }, (x, y) => seen.push([x, y]));
    expect(seen).toEqual([[77, 28]]);
  });

  it('walks Polygon (rings of points)', () => {
    const seen: Array<[number, number]> = [];
    visitCoords(
      { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      (x, y) => seen.push([x, y]),
    );
    expect(seen).toHaveLength(5);
    expect(seen[0]).toEqual([0, 0]);
  });

  it('walks MultiPolygon', () => {
    const seen: Array<[number, number]> = [];
    visitCoords(
      {
        type: 'MultiPolygon',
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          [[[5, 5], [6, 5], [6, 6], [5, 5]]],
        ],
      },
      (x, y) => seen.push([x, y]),
    );
    expect(seen).toHaveLength(8);
  });

  it('walks GeometryCollection', () => {
    const seen: Array<[number, number]> = [];
    visitCoords(
      {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [1, 2] },
          { type: 'Point', coordinates: [3, 4] },
        ],
      },
      (x, y) => seen.push([x, y]),
    );
    expect(seen).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('ignores undefined/null geometries', () => {
    const seen: Array<[number, number]> = [];
    visitCoords(null, (x, y) => seen.push([x, y]));
    visitCoords(undefined, (x, y) => seen.push([x, y]));
    visitCoords({ type: 'Point' }, (x, y) => seen.push([x, y]));
    expect(seen).toEqual([]);
  });
});

describe('validate', () => {
  const pt = (x: number, y: number, props: Record<string, unknown> = {}) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point', coordinates: [x, y] },
    properties: props,
  });

  it('counts features and breaks down by geometry type', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [
        pt(77, 28),
        pt(78, 29),
        {
          type: 'Feature' as const,
          geometry: { type: 'Polygon', coordinates: [[[77, 28], [78, 28], [78, 29], [77, 28]]] },
          properties: {},
        },
      ],
    };
    const r = validate(fc);
    expect(r.count).toBe(3);
    expect(r.byType).toEqual({ Point: 2, Polygon: 1 });
  });

  it('marks features without a geometry type as invalid', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [
        pt(77, 28),
        { type: 'Feature' as const, geometry: null, properties: {} },
        { type: 'Feature' as const, geometry: { foo: 'bar' } as unknown, properties: {} },
      ],
    };
    const r = validate(fc);
    expect(r.invalid).toBe(2);
    expect(r.byType).toEqual({ Point: 1 });
  });

  it('flags coordinates outside the India bbox', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [pt(77, 28), pt(-100, 40), pt(120, -20)],
    };
    const r = validate(fc);
    expect(r.outsideIndia).toBe(2);
  });

  it('computes a bbox of all coordinates', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [pt(70, 10), pt(95, 35)],
    };
    const r = validate(fc);
    expect(r.bbox).toEqual([70, 10, 95, 35]);
  });

  it('returns null bbox for an empty FC', () => {
    const r = validate({ type: 'FeatureCollection', features: [] });
    expect(r.bbox).toBeNull();
  });

  it('ranks top properties by frequency', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [pt(77, 28, { name: 'A', code: 1 }), pt(78, 29, { name: 'B' }), pt(79, 30, { code: 2 })],
    };
    const r = validate(fc);
    expect(r.topProps[0]).toBe('name'); // 2 occurrences, ties broken by insertion order
    expect(r.topProps).toContain('code');
  });

  it('carries CRS through from the raw input', () => {
    const fc = { type: 'FeatureCollection' as const, features: [] };
    const raw = { ...fc, crs: { properties: { name: 'urn:ogc:def:crs:EPSG::3857' } } };
    const r = validate(fc, raw);
    expect(r.crs).toBe('urn:ogc:def:crs:EPSG::3857');
  });

  it('skips infinite/NaN coords as invalid', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [
        { type: 'Feature' as const, geometry: { type: 'Point', coordinates: [Infinity, 28] }, properties: {} },
        { type: 'Feature' as const, geometry: { type: 'Point', coordinates: [NaN, NaN] }, properties: {} },
      ],
    };
    const r = validate(fc);
    expect(r.invalid).toBe(2);
  });
});

describe('featureCollectionBounds (fits the geojson-path view to the data)', () => {
  const fc = (features: FC['features']): FC => ({ type: 'FeatureCollection', features });
  const feat = (geometry: unknown): FC['features'][number] => ({ type: 'Feature', geometry, properties: null });

  it('returns null for an empty collection', () => {
    expect(featureCollectionBounds(fc([]))).toBeNull();
  });

  it('a single Point collapses to a degenerate bbox', () => {
    expect(featureCollectionBounds(fc([feat({ type: 'Point', coordinates: [73.9, 15.4] })]))).toEqual([73.9, 15.4, 73.9, 15.4]);
  });

  it('unions Point + MultiPolygon across features (the Goa shape)', () => {
    const b = featureCollectionBounds(fc([
      feat({ type: 'Point', coordinates: [73.85, 15.45] }),
      feat({ type: 'MultiPolygon', coordinates: [[[[73.7, 14.9], [74.1, 14.9], [74.1, 15.8], [73.7, 15.8], [73.7, 14.9]]]] }),
    ]));
    expect(b).toEqual([73.7, 14.9, 74.1, 15.8]);
  });

  it('ignores features with no geometry', () => {
    const b = featureCollectionBounds(fc([
      feat(null),
      feat({ type: 'Point', coordinates: [77, 28] }),
    ]));
    expect(b).toEqual([77, 28, 77, 28]);
  });
});
