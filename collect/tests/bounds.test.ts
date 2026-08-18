import { describe, it, expect } from 'vitest';
import { checkIndiaBounds, INDIA_BBOX } from '../src/geo/bounds';

// Step 1 of the record write path (spec → "POST /collections/:id/records"):
// every coordinate must lie in the India bbox; reject the whole record on any
// out-of-range vertex. Mirrors web/api/v1/locate's check (lat 6-38, lng 68-98).
describe('checkIndiaBounds', () => {
  it('accepts a point inside India (Bengaluru)', () => {
    expect(checkIndiaBounds({ type: 'Point', coordinates: [77.7176, 12.9899] }).ok).toBe(true);
  });

  it('rejects a point outside India (lng too high)', () => {
    const r = checkIndiaBounds({ type: 'Point', coordinates: [100.5, 12.9] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/68-98|India/);
  });

  it('accepts a LineString fully inside', () => {
    expect(checkIndiaBounds({ type: 'LineString', coordinates: [[77.5, 12.9], [77.6, 13.0]] }).ok).toBe(true);
  });

  it('rejects a LineString with ANY out-of-range vertex', () => {
    expect(checkIndiaBounds({ type: 'LineString', coordinates: [[77.5, 12.9], [200, 13.0]] }).ok).toBe(false);
  });

  it('accepts a Polygon inside (walks nested rings)', () => {
    const poly = { type: 'Polygon', coordinates: [[[77.5, 12.9], [77.6, 12.9], [77.6, 13.0], [77.5, 12.9]]] };
    expect(checkIndiaBounds(poly).ok).toBe(true);
  });

  it('accepts a MultiPolygon inside (deeper nesting)', () => {
    const mp = { type: 'MultiPolygon', coordinates: [[[[77.5, 12.9], [77.6, 12.9], [77.6, 13.0], [77.5, 12.9]]]] };
    expect(checkIndiaBounds(mp).ok).toBe(true);
  });

  it('treats the bbox edges as inclusive (68,6 and 98,38)', () => {
    expect(checkIndiaBounds({ type: 'Point', coordinates: [68, 6] }).ok).toBe(true);
    expect(checkIndiaBounds({ type: 'Point', coordinates: [98, 38] }).ok).toBe(true);
  });

  it('rejects malformed geometry rather than passing it', () => {
    expect(checkIndiaBounds(null).ok).toBe(false);
    expect(checkIndiaBounds({ type: 'Point' }).ok).toBe(false);
    expect(checkIndiaBounds({ type: 'Point', coordinates: ['a', 'b'] }).ok).toBe(false);
    expect(checkIndiaBounds({ type: 'Weird', coordinates: [1, 2] }).ok).toBe(false);
  });

  it('exposes the India bbox as [minLng, minLat, maxLng, maxLat]', () => {
    expect(INDIA_BBOX).toEqual([68, 6, 98, 38]);
  });
});
