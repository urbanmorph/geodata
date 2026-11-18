// Getting a photo ready on the phone: small enough for a weak signal, the
// place and time kept, the time in a form the server reads the same way.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fitWithin, sizeFor, photoMeta, preparePhoto } from '../src/photos/prepare';

// Low-end phones ran out of memory decoding a 12 MP photo at full size, once a
// round, into a new canvas each time. Now the browser decodes it already
// scaled down (where it can), into one canvas that is emptied afterwards.
describe('decoding a photo on a phone with little memory', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  type FakeCanvas = { width: number; height: number; getContext: () => { drawImage: ReturnType<typeof vi.fn> }; toBlob: (cb: (b: Blob) => void) => void };
  let canvases: FakeCanvas[];
  let draws: unknown[];
  let blobSizes: number[];

  function stubBrowser(bitmap: unknown) {
    canvases = []; draws = [];
    const drawImage = vi.fn((src: unknown) => void draws.push(src));
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('canvas');
        const c: FakeCanvas = {
          width: 300, height: 150,
          getContext: () => ({ drawImage }),
          // Too big for the first two tries, then small enough.
          toBlob: (cb) => cb(new Blob([JPEG, new Uint8Array((blobSizes.shift() ?? 1000) - JPEG.length)], { type: 'image/jpeg' })),
        };
        canvases.push(c);
        return c;
      },
    });
    vi.stubGlobal('Image', class {
      naturalWidth = 4000; naturalHeight = 3000; onload?: () => void; onerror?: () => void;
      set src(v: string) { if (v) setTimeout(() => this.onload?.()); }
    });
    vi.stubGlobal('createImageBitmap', bitmap);
  }
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks the browser for the photo already at its final size, draws into one canvas, then frees both', async () => {
    const bm = { width: 1600, height: 1200, close: vi.fn() };
    const createBitmap = vi.fn(async () => bm);
    stubBrowser(createBitmap);
    blobSizes = [900_000, 500_000, 400_000, 350_000, 1000];
    await preparePhoto(new File([JPEG], 'a.jpg', { type: 'image/jpeg' }), { dataSaver: false, source: 'camera' });
    expect(createBitmap).toHaveBeenCalledWith(expect.any(File), expect.objectContaining({ resizeWidth: 1600, resizeHeight: 1200, resizeQuality: 'high' }));
    expect(canvases).toHaveLength(1);
    expect(draws.every((d) => d === bm)).toBe(true);
    expect(bm.close).toHaveBeenCalled();
    expect(canvases[0].width).toBe(0);
    expect(canvases[0].height).toBe(0);
  });

  it('where the browser cannot scale while decoding, draws from the image as before', async () => {
    stubBrowser(undefined);
    blobSizes = [1000];
    const out = await preparePhoto(new File([JPEG], 'a.jpg', { type: 'image/jpeg' }), { dataSaver: false, source: 'gallery' });
    expect(out.meta).toEqual({ source: 'gallery' });
    expect(draws).toHaveLength(1);
    expect(draws[0]).not.toBeNull();
    expect(canvases[0].width).toBe(0);
  });

  it('a decoded copy the wrong way round (orientation not applied) is not used', async () => {
    const bm = { width: 1200, height: 1600, close: vi.fn() };
    stubBrowser(vi.fn(async () => bm));
    blobSizes = [1000];
    await preparePhoto(new File([JPEG], 'a.jpg', { type: 'image/jpeg' }), { dataSaver: false, source: 'camera' });
    expect(draws[0]).not.toBe(bm);
    expect(bm.close).toHaveBeenCalled();
  });
});

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
