// Opening a collect map with no signal: the map's form (meta) is saved on the
// phone whenever it loads online, and used only when the network is down. A
// real refusal (link turned off, map gone) still shows, never a stale copy.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { jsonWithOfflineCopy } from '../src/api';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k),
    clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
}
const online = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const offline = async (): Promise<Response> => { throw new TypeError('Failed to fetch'); };

describe('jsonWithOfflineCopy', () => {
  it('online: returns the fresh data and keeps a copy', async () => {
    const store = memoryStorage();
    expect(await jsonWithOfflineCopy('k', online({ name: 'Trees' }), store)).toEqual({ data: { name: 'Trees' }, offline: false });
    expect(JSON.parse(store.getItem('k')!)).toEqual({ name: 'Trees' });
  });

  it('offline: returns the copy from the last online load', async () => {
    const store = memoryStorage();
    await jsonWithOfflineCopy('k', online({ name: 'Trees' }), store);
    expect(await jsonWithOfflineCopy('k', offline, store)).toEqual({ data: { name: 'Trees' }, offline: true });
  });

  it('offline with no copy: says to open the map once with a connection', async () => {
    await expect(jsonWithOfflineCopy('k', offline, memoryStorage())).rejects.toThrow(/offline.*connection/i);
  });

  it('a refusal from the server is shown, not hidden behind the saved copy', async () => {
    const store = memoryStorage();
    await jsonWithOfflineCopy('k', online({ name: 'Trees' }), store);
    await expect(jsonWithOfflineCopy('k', online({ error: 'this link was turned off' }, 401), store)).rejects.toThrow('this link was turned off');
  });
});

describe('jsonWithOfflineCopy with a size limit', () => {
  it('keeps a copy only while it fits, and drops an outdated one that no longer does', async () => {
    const store = memoryStorage();
    await jsonWithOfflineCopy('k', online({ points: ['a'] }), store, 100);
    expect(store.getItem('k')).not.toBeNull();
    const big = { points: Array.from({ length: 50 }, (_, i) => `point-${i}`) };
    expect(await jsonWithOfflineCopy('k', online(big), store, 100)).toEqual({ data: big, offline: false });
    // Too big to keep: the old copy goes too, so offline never shows an outdated list as current.
    expect(store.getItem('k')).toBeNull();
    await expect(jsonWithOfflineCopy('k', offline, store, 100)).rejects.toThrow();
  });
});

describe('jsonWithOfflineCopy on a stalled connection', () => {
  afterEach(() => { vi.useRealTimers(); });
  const slow = (body: unknown, ms: number) => () => new Promise<Response>((r) => setTimeout(() => r(new Response(JSON.stringify(body))), ms));

  it('uses the saved copy after a few seconds, and keeps the late answer for next time', async () => {
    vi.useFakeTimers();
    const store = memoryStorage();
    store.setItem('k', JSON.stringify({ name: 'Trees' }));
    const res = jsonWithOfflineCopy('k', slow({ name: 'Trees v2' }, 20_000), store);
    await vi.advanceTimersByTimeAsync(3600);
    expect(await res).toEqual({ data: { name: 'Trees' }, offline: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(JSON.parse(store.getItem('k')!)).toEqual({ name: 'Trees v2' });
  });

  it('with no saved copy, waits for the network however long it takes', async () => {
    vi.useFakeTimers();
    const res = jsonWithOfflineCopy('k', slow({ name: 'Trees' }, 20_000), memoryStorage());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await res).toEqual({ data: { name: 'Trees' }, offline: false });
  });

  it('a late refusal never replaces the saved copy', async () => {
    vi.useFakeTimers();
    const store = memoryStorage();
    store.setItem('k', JSON.stringify({ name: 'Trees' }));
    const refused = () => new Promise<Response>((r) => setTimeout(() => r(new Response('{"error":"off"}', { status: 401 })), 20_000));
    const res = jsonWithOfflineCopy('k', refused, store);
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await res).offline).toBe(true);
    expect(JSON.parse(store.getItem('k')!)).toEqual({ name: 'Trees' });
  });
});


import { keepOfflineCopy, dropOfflineCopies, MAX_OFFLINE_COPIES } from '../src/offline-copies';

// localStorage also holds "Your maps", the only copy of a map's admin link, so
// the offline copies of maps are bounded and give way to it.
describe('offline copies are bounded', () => {
  it(`keeps only the ${MAX_OFFLINE_COPIES} most recently used copies`, () => {
    const store = memoryStorage();
    for (let i = 0; i < MAX_OFFLINE_COPIES + 3; i++) keepOfflineCopy(store, `collect:records:m${i}`, `{"i":${i}}`);
    expect(store.getItem('collect:records:m0')).toBeNull();
    expect(store.getItem('collect:records:m2')).toBeNull();
    expect(store.getItem(`collect:records:m${MAX_OFFLINE_COPIES + 2}`)).not.toBeNull();
    keepOfflineCopy(store, 'collect:records:m3', '{}'); // used again: now the newest
    keepOfflineCopy(store, 'collect:records:new', '{}');
    expect(store.getItem('collect:records:m3')).not.toBeNull();
    expect(store.getItem('collect:records:m4')).toBeNull();
  });
  it('when storage is full, drops the other copies and keeps the new one', () => {
    const store = memoryStorage();
    store.setItem('collect:maps', '[]');
    keepOfflineCopy(store, 'collect:meta:a', 'x'.repeat(10));
    keepOfflineCopy(store, 'collect:records:a', 'x'.repeat(10));
    const set = store.setItem.bind(store);
    store.setItem = (k, v) => { if (k === 'collect:records:b' && store.getItem('collect:records:a') !== null) throw new DOMException('full', 'QuotaExceededError'); set(k, v); };
    keepOfflineCopy(store, 'collect:records:b', 'y');
    expect(store.getItem('collect:records:b')).toBe('y');
    expect(store.getItem('collect:records:a')).toBeNull();
    expect(store.getItem('collect:maps')).toBe('[]');
  });
  it('dropOfflineCopies leaves everything else alone', () => {
    const store = memoryStorage();
    store.setItem('collect:maps', '[]');
    store.setItem('collect:contributor', 'A');
    keepOfflineCopy(store, 'collect:meta:a', '{}');
    dropOfflineCopies(store);
    expect(store.getItem('collect:meta:a')).toBeNull();
    expect(store.getItem('collect:maps')).toBe('[]');
    expect(store.getItem('collect:contributor')).toBe('A');
  });
});
