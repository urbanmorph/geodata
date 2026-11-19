// @vitest-environment happy-dom
// Saving a map is the only place its admin link is kept. When storage is full,
// the offline copies of maps give way; if it still can't be saved, the caller
// is told, so the page can show the link instead of saying it was saved.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveOwnedMap, myMaps } from '../src/maps-store';

const LINKS = { admin: 'https://collect.bharatlas.com/c/mapabc/admin#adm_1' };
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('saveOwnedMap when storage is full', () => {
  it('drops offline copies of maps to make room, then saves', () => {
    localStorage.setItem('collect:records:other', 'x'.repeat(100));
    const real = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
      if (k === 'collect:maps' && localStorage.getItem('collect:records:other') !== null) throw new DOMException('full', 'QuotaExceededError');
      return real(k, v);
    });
    expect(saveOwnedMap('mapabc', 'Trees', LINKS)).toBe(true);
    expect(myMaps()[0].links).toEqual(LINKS);
    expect(localStorage.getItem('collect:records:other')).toBeNull();
  });
  it('says so when it still cannot save', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(saveOwnedMap('mapabc', 'Trees', LINKS)).toBe(false);
  });
});
