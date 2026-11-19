// @vitest-environment happy-dom
// The face check decodes the photo once more; that copy is let go straight after.
import { describe, it, expect, vi } from 'vitest';
import { mayShowFace } from '../src/photos/prepare';

describe('mayShowFace', () => {
  it('closes the bitmap it decoded', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', async () => ({ close }));
    vi.stubGlobal('FaceDetector', class { async detect() { return [{}]; } });
    expect(await mayShowFace(new Blob(['x']))).toBe(true);
    expect(close).toHaveBeenCalled();
  });
});
