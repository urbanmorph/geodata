// Getting a photo ready on the phone: small enough for a weak signal, the
// place and time kept, the time in a form the server reads the same way.
import { describe, it, expect } from 'vitest';
import { fitWithin, sizeFor, photoMeta } from '../src/photos/prepare';

describe('preparing a photo', () => {
  it('fits the long edge within the limit, keeping the shape', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual([1600, 1200]);
    expect(fitWithin(3000, 4000, 1600)).toEqual([1200, 1600]);
    expect(fitWithin(800, 600, 1600)).toEqual([800, 600]);
  });

  it('aims at about 300 KB, or 150 KB with Data saver', () => {
    expect(sizeFor(false)).toEqual({ bytes: 300_000, edge: 1600 });
    expect(sizeFor(true)).toEqual({ bytes: 150_000, edge: 1024 });
  });

  it('sends the camera time as an exact moment, and the place only when there is one', () => {
    const m = photoMeta({ lat: 12.9, lng: 77.6, takenAt: '2026-10-24T09:15:00+05:30' }, 'camera');
    expect(m).toEqual({ lat: 12.9, lng: 77.6, taken_at: '2026-10-24T03:45:00.000Z', source: 'camera' });
    expect(photoMeta({}, 'gallery')).toEqual({ source: 'gallery' });
    // A camera time with no offset is the phone's own local time.
    const local = photoMeta({ takenAt: '2026-10-24T09:15:00' }, 'camera');
    expect(local.taken_at).toBe(new Date('2026-10-24T09:15:00').toISOString());
  });
});
