// The "Your name" box on a collect form, remembered on this device for every
// map and every visit (it used to live only in memory, so each reload cleared
// it). A per-device convenience: blocked storage just means retyping it.

const KEY = 'collect:contributor';

export function loadContributorName(store: Storage = localStorage): string {
  try {
    return store.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveContributorName(name: string, store: Storage = localStorage): void {
  const v = name.trim();
  try {
    if (v) store.setItem(KEY, v);
    else store.removeItem(KEY);
  } catch { /* per-device convenience only */ }
}
