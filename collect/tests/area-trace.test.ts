// Marking a farm by walking around it or standing at each corner.
import { describe, it, expect } from 'vitest';
import { ringArea, formatArea, metresBetween, simplify } from '../src/geo/measure';
import { createTrace, averageFix, type Fix } from '../src/capture/trace';

// ~1 m ≈ 9e-6 degrees of latitude near Bengaluru.
const M = 1 / 111_320;
const at = (eastM: number, northM: number, accuracy = 4, t = 0): Fix =>
  ({ lng: 77.6 + (eastM * M) / Math.cos((12.97 * Math.PI) / 180), lat: 12.97 + northM * M, accuracy, t });

describe('measuring', () => {
  it('a 100 m square is about a hectare (2.47 acres)', () => {
    const sq = [at(0, 0), at(100, 0), at(100, 100), at(0, 100)].map((f) => [f.lng, f.lat] as [number, number]);
    expect(ringArea(sq)).toBeGreaterThan(9900);
    expect(ringArea(sq)).toBeLessThan(10100);
  });

  it('says areas in acres and guntas (40 guntas to an acre), and square metres when small', () => {
    expect(formatArea(4046.86 * 1.25)).toBe('1 acre 10 guntas');
    expect(formatArea(4046.86 * 3)).toBe('3 acres');
    expect(formatArea(101.17 * 5)).toBe('5 guntas');
    expect(formatArea(60)).toBe('60 m²');
  });

  it('measures distance in metres', () => {
    const a = at(0, 0), b = at(30, 40);
    expect(metresBetween([a.lng, a.lat], [b.lng, b.lat])).toBeCloseTo(50, 0);
  });

  it('simplifies a walked line without losing its corners', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 50; i++) { const f = at(i * 2, (i % 2) * 0.3); pts.push([f.lng, f.lat]); } // wobbly straight edge
    const c = at(100, 80); pts.push([c.lng, c.lat]);
    const s = simplify(pts, 2);
    expect(s.length).toBeLessThan(6);
    expect(s[0]).toEqual(pts[0]);
    expect(s[s.length - 1]).toEqual(pts[pts.length - 1]);
  });
});

describe('walking around a field', () => {
  it('skips poor readings and readings too close together', () => {
    const t = createTrace();
    expect(t.add(at(0, 0))).toBe('added');
    expect(t.add(at(1, 0))).toBe('too-close');
    expect(t.add(at(20, 0, 60))).toBe('poor');
    expect(t.add(at(20, 0))).toBe('added');
    expect(t.points()).toHaveLength(2);
  });

  it('closes when back near the start after going round, and reports the area live', () => {
    const t = createTrace();
    for (const [e, n] of [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100], [50, 100], [0, 100], [0, 50]]) t.add(at(e, n));
    expect(t.closed()).toBe(false);
    expect(t.area()).toBeGreaterThan(9000);
    t.add(at(3, 4));
    expect(t.closed()).toBe(true);
  });

  it('does not close at the start before going anywhere', () => {
    const t = createTrace();
    t.add(at(0, 0)); t.add(at(10, 0)); t.add(at(3, 2));
    expect(t.closed()).toBe(false);
  });

  it('pause stops taking readings until resumed', () => {
    const t = createTrace();
    t.add(at(0, 0));
    t.pause();
    expect(t.add(at(30, 0))).toBe('paused');
    t.resume();
    expect(t.add(at(30, 0))).toBe('added');
  });
});

describe('standing at a corner', () => {
  it('averages the readings, weighting the more accurate ones', () => {
    const fixes = [at(0, 0, 3), at(2, 0, 3), at(40, 0, 50)];
    const c = averageFix(fixes)!;
    const centre = at(1, 0);
    expect(metresBetween([c.lng, c.lat], [centre.lng, centre.lat])).toBeLessThan(1.5);
    expect(c.accuracy).toBeLessThan(4);
  });

  it('gives nothing without usable readings', () => {
    expect(averageFix([])).toBeNull();
    expect(averageFix([at(0, 0, 80)])).toBeNull();
  });
});
