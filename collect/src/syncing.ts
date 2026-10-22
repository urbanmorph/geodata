// Browser side of the opt-in keyring sync (see keyring.ts for the crypto).
// Holds the secret in localStorage on each device that joined, syncs on page
// load and shortly after any change to "Your maps", and turns off cleanly.
import { api } from './api';
import { deriveKeys, newSecret, syncNow, syncLink, SyncGone, type KeyringApi } from './keyring';
import { myMaps, replaceMaps, MAPS_CHANGED } from './maps-store';

const KEY = 'collect:keyring';
export interface SyncState { secret: string; synced_at?: string; }

export { SyncGone };

export function syncState(): SyncState | null {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null') as SyncState | null; } catch { return null; }
}
function saveState(s: SyncState | null): void {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* best effort */ }
}

const http: KeyringApi = {
  async get(id) {
    const r = await api(`/keyrings/${id}`, '');
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`sync failed (HTTP ${r.status})`);
    return r.json();
  },
  async put(id, writeKey, blob, base) {
    const r = await api(`/keyrings/${id}`, writeKey, { method: 'PUT', body: JSON.stringify({ blob, base }) });
    if (r.status === 409) return { conflict: await r.json() };
    if (r.status === 410) throw new SyncGone('sync was turned off on another device');
    if (!r.ok) throw new Error(`sync failed (HTTP ${r.status})`);
    return r.json();
  },
};

let applying = false; // our own replaceMaps must not schedule another push

// One round: pull, merge, push, then store the merged list locally.
export async function syncDevice(): Promise<void> {
  const st = syncState();
  if (!st) return;
  try {
    const out = await syncNow(await deriveKeys(st.secret), myMaps(), http, { joined: !!st.synced_at });
    applying = true;
    replaceMaps(out.maps);
    applying = false;
    saveState({ ...st, synced_at: new Date().toISOString() });
  } catch (e) {
    applying = false;
    if (e instanceof SyncGone) saveState(null);
    throw e;
  }
}

export async function turnOnSync(): Promise<void> {
  saveState({ secret: newSecret() });
  await syncDevice();
}

// Opened a sync link on this device: adopt its secret and merge both lists.
export async function joinSync(secret: string): Promise<void> {
  saveState({ secret });
  await syncDevice();
}

// Turn off everywhere: delete the server copy, then forget the secret here.
// Other devices learn on their next write (410) and stop too.
export async function turnOffSync(): Promise<void> {
  const st = syncState();
  if (!st) return;
  const k = await deriveKeys(st.secret);
  const r = await api(`/keyrings/${k.id}`, k.writeKey, { method: 'DELETE' });
  if (!r.ok) throw new Error(`couldn't delete the synced copy (HTTP ${r.status})`);
  saveState(null);
}

export function mySyncLink(): string | null {
  const st = syncState();
  return st ? syncLink(location.origin, st.secret) : null;
}

// Push local changes ~2s after they settle. Errors are quiet here; the landing
// shows sync status and retries on the next load.
export function startAutoSync(onError?: (e: Error) => void): void {
  let t: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener(MAPS_CHANGED, () => {
    if (applying || !syncState()) return;
    clearTimeout(t);
    t = setTimeout(() => { syncDevice().catch((e: Error) => onError?.(e)); }, 2000);
  });
}
