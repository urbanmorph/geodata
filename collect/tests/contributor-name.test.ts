// The "Your name" box on a collect form: typed once, remembered on this phone
// for every map and every visit. It used to live only in memory, so a reload
// (or reopening the installed app) cleared it and a student retyped it per point.
import { describe, it, expect } from 'vitest';
import { loadContributorName, saveContributorName } from '../src/contributor-name';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k),
    clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
}
const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } } as unknown as Storage;

describe('contributor name', () => {
  it('is empty until one is typed', () => {
    expect(loadContributorName(memoryStorage())).toBe('');
  });

  it('is remembered across visits', () => {
    const store = memoryStorage();
    saveContributorName('  Aarushi ', store);
    expect(loadContributorName(store)).toBe('Aarushi');
  });

  it('clearing the box forgets it', () => {
    const store = memoryStorage();
    saveContributorName('Aarushi', store);
    saveContributorName('', store);
    expect(loadContributorName(store)).toBe('');
    expect(store.length).toBe(0);
  });

  it('never breaks saving a point when storage is blocked (private mode)', () => {
    expect(() => saveContributorName('Aarushi', broken)).not.toThrow();
    expect(loadContributorName(broken)).toBe('');
  });
});
