import { describe, it, expect } from 'vitest';
import { imageFilename, dataUrlToBlob } from '../src/image-export';

describe('image-export — imageFilename', () => {
  it('formats a sortable timestamp with UTC parts', () => {
    const d = new Date(Date.UTC(2026, 4, 22, 9, 7));
    expect(imageFilename('lgd_villages', d)).toBe('bharatlas-lgd_villages-20260522-0907.png');
  });

  it('sanitises spicy filename characters', () => {
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0));
    expect(imageFilename('wards/chennai 2025', d)).toBe('bharatlas-wards_chennai_2025-20260101-0000.png');
  });

  it('zero-pads single-digit month, day, hour, minute', () => {
    const d = new Date(Date.UTC(2026, 0, 5, 3, 4));
    expect(imageFilename('x', d)).toBe('bharatlas-x-20260105-0304.png');
  });

  it('ends in .png', () => {
    expect(imageFilename('x')).toMatch(/\.png$/);
  });
});

describe('image-export — dataUrlToBlob', () => {
  it('round-trips a tiny base64 PNG', () => {
    // 1×1 transparent PNG.
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
    const blob = dataUrlToBlob(dataUrl);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('throws on a non-base64 data URL', () => {
    expect(() => dataUrlToBlob('not-a-data-url')).toThrow();
  });
});
