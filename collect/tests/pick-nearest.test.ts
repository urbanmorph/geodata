// Tapping a point with a finger: a 12px dot is smaller than a fingertip, so a
// tap counts for the nearest point within a radius around it, not only an exact
// hit on the dot's pixels (which on an iPad meant tap after tap missed).
import { describe, it, expect } from 'vitest';
import { pickNearest } from '../src/pick-nearest';

const at = (idx: number, x: number, y: number) => ({ idx, x, y });

describe('pickNearest', () => {
  it('picks the closest point to the tap', () => {
    expect(pickNearest([at(1, 110, 100), at(2, 104, 103), at(3, 90, 90)], { x: 100, y: 100 }, 14)).toBe(2);
  });
  it('ignores points beyond the radius', () => {
    expect(pickNearest([at(1, 130, 100)], { x: 100, y: 100 }, 14)).toBeNull();
  });
  it('nothing near: null', () => {
    expect(pickNearest([], { x: 0, y: 0 }, 14)).toBeNull();
  });
});
