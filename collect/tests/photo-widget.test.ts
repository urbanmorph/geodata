// @vitest-environment happy-dom
// The Photo question on the form: take or choose up to the limit, remove, and
// a face warning where the phone can tell.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let face = false;
vi.mock('../src/photos/prepare', () => ({
  preparePhoto: async (_f: File, o: { source: string }) => ({ bytes: new ArrayBuffer(3), blob: new Blob(['x'], { type: 'image/jpeg' }), meta: { lat: 12.9, lng: 77.6, source: o.source } }),
  mayShowFace: async () => face,
}));
const { mountPhotoField } = await import('../src/photos/widget');

const flush = () => new Promise((r) => setTimeout(r, 0));
const pick = async (host: HTMLElement, src: 'camera' | 'gallery') => {
  const input = host.querySelector<HTMLInputElement>(`input[data-src="${src}"]`)!;
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] });
  input.dispatchEvent(new Event('change'));
  await flush(); await flush();
};

beforeEach(() => { document.body.innerHTML = '<div id="h"></div>'; face = false; URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = () => {}; });

describe('the Photo question', () => {
  it('takes photos up to the limit, then offers no more', async () => {
    const host = document.getElementById('h')!;
    const added: unknown[] = [];
    const pf = mountPhotoField(host, { key: 'pic', label: 'Photo', type: 'photo', max_photos: 2 }, { dataSaver: false, onAdded: (i) => added.push(i) });
    expect(host.querySelector('input[capture="environment"]')).toBeTruthy();
    await pick(host, 'camera');
    await pick(host, 'gallery');
    expect(pf.items().map((i) => i.meta.source)).toEqual(['camera', 'gallery']);
    expect(added).toHaveLength(2);
    expect(host.querySelector('input[type=file]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-rm="0"]')!.click();
    expect(pf.items()).toHaveLength(1);
    expect(host.querySelector('input[type=file]')).toBeTruthy();
  });

  it('never goes over the limit, even when a second photo is picked while the first is being made ready', async () => {
    const host = document.getElementById('h')!;
    const pf = mountPhotoField(host, { key: 'pic', label: 'Photo', type: 'photo', max_photos: 1 }, { dataSaver: false });
    const input = host.querySelector<HTMLInputElement>('input[data-src="camera"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] });
    input.dispatchEvent(new Event('change'));
    expect(host.querySelector('input[type=file]')).toBeNull(); // no second pick while the first is being made ready
    input.dispatchEvent(new Event('change')); // a stale input firing again
    await flush(); await flush();
    expect(pf.items()).toHaveLength(1);
  });

  it('warns when a photo may show a face', async () => {
    face = true;
    const host = document.getElementById('h')!;
    mountPhotoField(host, { key: 'pic', label: 'Photo', type: 'photo' }, { dataSaver: true });
    await pick(host, 'camera');
    expect(host.textContent).toMatch(/may show a face/);
  });

  it('shows existing photos but cannot add where uploads are not allowed', () => {
    const host = document.getElementById('h')!;
    const pf = mountPhotoField(host, { key: 'pic', label: 'Photo', type: 'photo' }, { dataSaver: false, canAdd: false, initial: [{ id: 'ph_aaaaaaaaaaaa', url: 'https://x/p' }] });
    expect(pf.items().map((i) => i.id)).toEqual(['ph_aaaaaaaaaaaa']);
    expect(host.querySelector('input[type=file]')).toBeNull();
  });
});
