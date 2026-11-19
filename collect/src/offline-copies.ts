// The copies of maps kept on the phone for opening them with no signal
// (api.ts jsonWithOfflineCopy: a map's form and its points). They share
// localStorage with "Your maps", the only copy of a map's admin link, so they
// are bounded (the most recently used few) and give way when storage is full.

const PREFIXES = ['collect:meta:', 'collect:records:'];
const ORDER = 'collect:offline-order';
/** Copies kept: a map has two (its form and its points). */
export const MAX_OFFLINE_COPIES = 12;

const isCopy = (key: string): boolean => PREFIXES.some((p) => key.startsWith(p));

function order(store: Storage): string[] {
  try {
    const v = JSON.parse(store.getItem(ORDER) || '[]') as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch { return []; }
}

/** Every offline copy (but `keep`) removed: storage is needed for something that matters more. */
export function dropOfflineCopies(store: Storage, keep?: string): void {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k && isCopy(k) && k !== keep) keys.push(k); }
  for (const k of keys) store.removeItem(k);
  try { store.setItem(ORDER, JSON.stringify(keep && store.getItem(keep) !== null ? [keep] : [])); } catch { /* order is a hint only */ }
}

/** Keep (or refresh) one copy as the most recently used; the oldest beyond the
 *  limit go. Storage full: the other copies go, then one more try. Never throws. */
export function keepOfflineCopy(store: Storage, key: string, value: string): void {
  try {
    const keys = [...order(store).filter((k) => k !== key), key];
    for (const old of keys.splice(0, Math.max(0, keys.length - MAX_OFFLINE_COPIES))) store.removeItem(old);
    try {
      store.setItem(key, value);
    } catch {
      dropOfflineCopies(store);
      store.setItem(key, value);
      keys.splice(0, keys.length, key);
    }
    store.setItem(ORDER, JSON.stringify(keys));
  } catch { /* still works online */ }
}
