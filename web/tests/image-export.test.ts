import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { imageFilename, captureMapPng } from '../src/image-export';

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

// Without preserveDrawingBuffer (a cost on every map, every frame) the WebGL
// canvas is only readable during the frame that drew it: so the PNG is read
// inside a 'render' event, after the tiles have settled ('idle').
describe('image-export — captureMapPng', () => {
  function fakeMap() {
    const handlers: Record<string, (() => void)[]> = {};
    const log: string[] = [];
    let drawing = false; // true only while a frame is being rendered
    const map = {
      once(type: string, fn: () => void) { (handlers[type] ||= []).push(fn); },
      triggerRepaint() {
        log.push('repaint');
        queueMicrotask(() => {
          drawing = true;
          for (const fn of handlers.render?.splice(0) || []) fn();
          drawing = false;
          for (const fn of handlers.idle?.splice(0) || []) fn();
        });
      },
      getCanvas: () => ({
        toBlob(cb: (b: Blob | null) => void, type: string) {
          log.push(drawing ? 'read-in-frame' : 'read-outside-frame');
          cb(drawing ? new Blob(['png'], { type }) : null);
        },
      }),
    };
    return { map, log };
  }

  it('reads the canvas inside a render frame once the map is idle', async () => {
    const { map, log } = fakeMap();
    const blob = await captureMapPng(map as never);
    expect(blob.type).toBe('image/png');
    expect(log).toEqual(['repaint', 'repaint', 'read-in-frame']);
  });

  it('maps no longer keep the drawing buffer just for the export', () => {
    expect(readFileSync(resolve(__dirname, '..', 'src', 'map.ts'), 'utf8')).not.toMatch(/preserveDrawingBuffer:\s*true/);
  });
});

// One download helper for the map PNG, filtered exports and the token backup.
describe('one download helper (util.triggerDownload)', () => {
  const src = (f: string) => readFileSync(resolve(__dirname, '..', 'src', f), 'utf8');
  it('no module keeps its own copy of the anchor-click download', () => {
    for (const f of ['filter.ts', 'preview.ts', 'map.ts', 'image-export.ts']) {
      expect(src(f), f).not.toMatch(/\.download\s*=/);
    }
  });
});
