import { describe, it, expect } from 'vitest';
import { pointInPolygon } from '../functions/lib/point-in-polygon';

const square: [number, number][] = [
  [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
];

const lShape: [number, number][] = [
  [0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10], [0, 0],
];

describe('pointInPolygon', () => {
  it('returns true for point inside a square', () => {
    expect(pointInPolygon([5, 5], [square])).toBe(true);
  });

  it('returns false for point outside a square', () => {
    expect(pointInPolygon([15, 5], [square])).toBe(false);
  });

  it('returns false for point clearly outside', () => {
    expect(pointInPolygon([-5, -5], [square])).toBe(false);
  });

  it('handles L-shaped polygon', () => {
    expect(pointInPolygon([2, 2], [lShape])).toBe(true);
    expect(pointInPolygon([7, 7], [lShape])).toBe(false);
    expect(pointInPolygon([2, 8], [lShape])).toBe(true);
  });

  it('handles polygon with hole', () => {
    const outer: [number, number][] = [
      [0, 0], [20, 0], [20, 20], [0, 20], [0, 0],
    ];
    const hole: [number, number][] = [
      [5, 5], [15, 5], [15, 15], [5, 15], [5, 5],
    ];
    expect(pointInPolygon([10, 10], [outer, hole])).toBe(false);
    expect(pointInPolygon([2, 2], [outer, hole])).toBe(true);
    expect(pointInPolygon([25, 25], [outer, hole])).toBe(false);
  });

  it('handles multi-ring input (outer only)', () => {
    expect(pointInPolygon([5, 5], [square])).toBe(true);
  });
});
