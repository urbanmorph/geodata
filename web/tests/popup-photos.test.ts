// A published collect map's photos show as pictures in the map pop-up, not as links.
import { describe, it, expect } from 'vitest';
import { collectPhotoUrls, popupValueHtml } from '../src/popup-value';

const U = 'https://collect.bharatlas.com/api/collect/v1/photos/ph_abcdefghijklmnop';

describe('photos in the pop-up', () => {
  it('finds collect photo links, alone, in a list, or as a tile attribute (JSON text)', () => {
    expect(collectPhotoUrls(U)).toEqual([U]);
    expect(collectPhotoUrls([U, `${U}2`])).toEqual([U, `${U}2`]);
    expect(collectPhotoUrls(JSON.stringify([U]))).toEqual([U]);
    expect(collectPhotoUrls('https://evil.example/x.jpg')).toEqual([]);
    expect(collectPhotoUrls('Ragi')).toEqual([]);
  });

  it('shows photos as small pictures linked to the full photo, and other values as text', () => {
    const html = popupValueHtml([U]);
    expect(html).toContain(`<img src="${U}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain(`href="${U}"`);
    expect(popupValueHtml('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
  });
});
