import { describe, it, expect } from 'vitest';
import { geometryLngLats } from '../src/geo/coords';

describe('geometryLngLats', () => {
  it('a Point is one pair', () => {
    expect(geometryLngLats([77, 12])).toEqual([[77, 12]]);
  });
  it('a LineString is its vertices', () => {
    expect(geometryLngLats([[77, 12], [78, 13]])).toEqual([[77, 12], [78, 13]]);
  });
  it('a Polygon ring flattens to its points', () => {
    expect(geometryLngLats([[[77, 12], [78, 12], [78, 13], [77, 12]]])).toHaveLength(4);
  });
  it('a MultiPolygon flattens across parts', () => {
    const mp = [[[[77, 12], [78, 12], [78, 13], [77, 12]]], [[[80, 20], [81, 20], [81, 21], [80, 20]]]];
    expect(geometryLngLats(mp)).toHaveLength(8);
  });
  it('non-array input yields nothing (defensive)', () => {
    expect(geometryLngLats(null)).toEqual([]);
    expect(geometryLngLats(undefined)).toEqual([]);
  });
});
