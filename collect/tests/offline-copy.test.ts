// Opening a collect map with no signal: the map's form (meta) is saved on the
// phone whenever it loads online, and used only when the network is down. A
// real refusal (link turned off, map gone) still shows, never a stale copy.
import { describe, it, expect } from 'vitest';
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

