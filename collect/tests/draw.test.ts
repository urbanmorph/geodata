import { describe, it, expect } from 'vitest';
import { drawGeometry, orderedModes, type GeomMode } from '../src/geo/draw';

const C: [number, number] = [77.6, 12.9];
const V: [number, number][] = [[77.6, 12.9], [77.7, 12.9], [77.7, 13.0]];

describe('drawGeometry', () => {
  it('point uses the map centre, ignoring vertices', () => {
    expect(drawGeometry('point', [], C)).toEqual({ type: 'Point', coordinates: C });
  });

  it('line needs at least two vertices', () => {
    expect(drawGeometry('line', [V[0]], C)).toBeNull();
    expect(drawGeometry('line', [V[0], V[1]], C)).toEqual({ type: 'LineString', coordinates: [V[0], V[1]] });
  });

  it('polygon needs at least three vertices and closes the ring', () => {
    expect(drawGeometry('polygon', [V[0], V[1]], C)).toBeNull();
    expect(drawGeometry('polygon', V, C)).toEqual({
      type: 'Polygon',
      coordinates: [[V[0], V[1], V[2], V[0]]],
    });
  });
});

describe('orderedModes', () => {
  it('keeps only valid declared modes, point first', () => {
    expect(orderedModes(['polygon', 'point', 'line'])).toEqual(['point', 'line', 'polygon']);
    expect(orderedModes(['point'])).toEqual(['point']);
    expect(orderedModes(['line', 'polygon'])).toEqual(['line', 'polygon']);
  });
  it('falls back to point when nothing valid is declared', () => {
    expect(orderedModes([])).toEqual(['point']);
    expect(orderedModes(['blob' as GeomMode])).toEqual(['point']);
  });
});
