// A collect photo keeps where and when it was taken, and nothing else from the camera.
import { describe, it, expect } from 'vitest';
import { readExif, writeExif, stripExif } from '../src/photos/exif';

// A minimal JPEG: SOI, an APP0 (JFIF), a start-of-scan with a byte of data, EOI.
const JFIF = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
const SCAN = [0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9];
const jpeg = (extra: number[] = []) => new Uint8Array([0xff, 0xd8, ...extra, ...JFIF, ...SCAN]);

// An APP1 with a "Make" tag (a camera detail that must not survive), little-endian.
function cameraApp1(): number[] {
  const make = [...'PhoneCo'].map((c) => c.charCodeAt(0)).concat(0); // 8 bytes
  const tiff = [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 0, 0x0f, 0x01, 2, 0, 8, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0, ...make];
  const len = tiff.length + 8;
  return [0xff, 0xe1, len >> 8, len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
}

describe('photo EXIF', () => {
  it('writes the place and time and reads them back', () => {
    const out = writeExif(jpeg(), { lat: 12.97162, lng: 77.59456, takenAt: '2026-10-24T09:15:30+05:30' });
    const r = readExif(out);
    expect(r.lat).toBeCloseTo(12.97162, 5);
    expect(r.lng).toBeCloseTo(77.59456, 5);
    expect(r.takenAt).toBe('2026-10-24T09:15:30+05:30');
  });

  it('handles the southern and western hemispheres, and a time without an offset', () => {
    const r = readExif(writeExif(jpeg(), { lat: -33.8688, lng: -70.65, takenAt: '2026-01-02T03:04' }));
    expect(r.lat).toBeCloseTo(-33.8688, 5);
    expect(r.lng).toBeCloseTo(-70.65, 5);
    expect(r.takenAt).toBe('2026-01-02T03:04:00');
  });

  it('drops every other camera detail', () => {
    const withCamera = jpeg(cameraApp1());
    expect(new TextDecoder().decode(withCamera)).toContain('PhoneCo');
    const out = writeExif(withCamera, { takenAt: '2026-10-24T09:15:00' });
    expect(new TextDecoder().decode(out)).not.toContain('PhoneCo');
    expect(readExif(out).takenAt).toBe('2026-10-24T09:15:00');
    expect(new TextDecoder().decode(stripExif(withCamera))).not.toContain('PhoneCo');
  });

  it('keeps the rest of the image intact', () => {
    const out = writeExif(jpeg(), { lat: 1, lng: 2 });
    expect([...out.slice(-SCAN.length)]).toEqual(SCAN);
    expect([...out.slice(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it('reads nothing from a photo without EXIF, or from something that is not a JPEG', () => {
    expect(readExif(jpeg())).toEqual({});
    expect(readExif(new Uint8Array([1, 2, 3]))).toEqual({});
    expect(writeExif(jpeg(), {})).toEqual(jpeg());
  });

  it('reads a little-endian camera block without crashing', () => {
    expect(readExif(jpeg(cameraApp1()))).toEqual({});
  });
});

describe('damaged photos', () => {
  it('a photo cut off inside its EXIF block, or with a bad header, has no place or time (and never throws)', () => {
    const cut = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d]);
    expect(readExif(cut)).toEqual({});
    const bad = writeExif(jpeg(), { lat: 1, lng: 2 });
    bad[12] = 0x58; // corrupt the TIFF byte-order mark
    expect(readExif(bad)).toEqual({});
  });
});
