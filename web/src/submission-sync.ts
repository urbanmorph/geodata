// "Your submissions" on all your devices: the admin links bharatlas keeps in this
// browser (my-submissions.ts) are the only way to manage a published layer, so
// losing the browser's storage used to lose them. This syncs them, end to end
// encrypted, through the same keyring service as collect (shared/keyring.ts):
// its own blob, derived from the same secret with its own label, so one sync link
// or one passkey unlocks both apps and neither can overwrite the other's copy.
//
// Turning it off here deletes only bharatlas's copy, never the passkey's stored
// secret, which collect's sync may still use.
import {
  deriveKeys, keyringHttp, newSecret, sealJson, syncDoc, SyncGone, unsealJson,
  type KeyringServer,
} from '../../shared/keyring';
import { createPasskeyPrf, passkeyPrf, recoverSecret, storeWrappedSecret, type PasskeyHandle } from '../../shared/passkey';
import { listSubmissions, saveSubmission, type StoredSubmission } from './my-submissions';

export { syncSecretFrom } from '../../shared/keyring';

export const SUBMISSIONS_LABEL = 'bharatlas-submissions';
const STATE_KEY = 'bharatlas:keyring';
export const SUBMISSIONS_CHANGED = 'bharatlas:submissions-changed';

export interface SyncState { secret: string; synced_at?: string; passkey?: PasskeyHandle }

/** Both devices' links, each once (same id, same link), newest first. */
export function mergeSubmissions(a: StoredSubmission[], b: StoredSubmission[]): StoredSubmission[] {
  const byId = new Map<string, StoredSubmission>();
  for (const s of [...a, ...b]) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()].sort((x, y) => y.created_at - x.created_at);
}

const codec = {
  seal: (encKey: CryptoKey, subs: StoredSubmission[]) => sealJson(encKey, { v: 1, submissions: subs }),
  async unseal(encKey: CryptoKey, blob: string): Promise<StoredSubmission[]> {
    const doc = await unsealJson<{ v: number; submissions: StoredSubmission[] }>(encKey, blob);
    if (doc.v !== 1 || !Array.isArray(doc.submissions)) throw new Error('unknown keyring format');
    return doc.submissions;
  },
  merge: mergeSubmissions,
};

export interface SubmissionSyncDeps {
  api: KeyringServer;
  storage: Storage;
  /** The passkey's PRF bytes: a new passkey, or an existing one (shows the OS sheet). */
  passkey: { create(): Promise<Uint8Array>; get(): Promise<Uint8Array> };
}

export function createSubmissionSync({ api, storage, passkey }: SubmissionSyncDeps) {
  const state = (): SyncState | null => {
    try { return JSON.parse(storage.getItem(STATE_KEY) || 'null') as SyncState | null; } catch { return null; }
  };
  const saveState = (s: SyncState | null) => {
    try { if (s) storage.setItem(STATE_KEY, JSON.stringify(s)); else storage.removeItem(STATE_KEY); } catch { /* best effort */ }
  };
  const list = () => listSubmissions(storage);

  // One round: pull, merge, push, then keep the merged list here.
  async function syncNow(): Promise<void> {
    const st = state();
    if (!st) return;
    try {
      const keys = await deriveKeys(st.secret, SUBMISSIONS_LABEL);
      // Only a device that synced bharatlas's copy before treats a missing copy as
      // "turned off". A passkey from collect, used here the first time, finds none
      // yet and creates it (unlike collect, whose copy always exists behind its passkey).
      const out = await syncDoc(keys, list(), api, codec, { joined: !!st.synced_at });
      for (const s of out.value) saveSubmission(s, storage);
      saveState({ ...st, synced_at: new Date().toISOString() });
    } catch (e) {
      if (e instanceof SyncGone) saveState(null); // turned off elsewhere: stop here too
      throw e;
    }
  }

  return {
    state,
    list,
    syncNow,
    /** Keep a new submission's link here (and in the synced copy at the next sync). */
    saveLocal: (s: StoredSubmission) => saveSubmission(s, storage),
    /** This device's sync link (keep private), or null when sync is off. */
    link: (origin: string) => {
      const st = state();
      return st ? `${origin}/preview#sync=${st.secret}` : null;
    },
    async turnOn() {
      saveState({ secret: newSecret() });
      await syncNow();
    },
    /** Opened a sync link here: adopt its secret and merge both lists. */
    async join(secret: string) {
      saveState({ secret });
      await syncNow();
    },
    async turnOff() {
      const st = state();
      if (!st) return;
      const keys = await deriveKeys(st.secret, SUBMISSIONS_LABEL);
      await api.delete(keys.id, keys.writeKey);
      saveState(null);
    },
    async addPasskey() {
      const st = state();
      if (!st) throw new Error('turn on sync first');
      saveState({ ...st, passkey: await storeWrappedSecret(await passkey.create(), st.secret, api) });
    },
    /** A new device: the passkey (made here or in collect) recovers the secret. */
    async unlockWithPasskey() {
      const found = await recoverSecret(await passkey.get(), api);
      if (!found) throw new Error('no synced copy for this passkey (it may have been turned off)');
      saveState({ secret: found.secret, passkey: found.handle });
      await syncNow();
    },
  };
}

/** collect's keyring API; a local build can point it at a local collect (VITE_COLLECT_API). */
const COLLECT_API = (import.meta.env.VITE_COLLECT_API || 'https://collect.bharatlas.com/api/collect/v1').replace(/\/$/, '');

/** The browser's sync, with the real server and passkeys. */
export const submissionSync = () =>
  createSubmissionSync({ api: keyringHttp(COLLECT_API), storage: localStorage, passkey: { create: createPasskeyPrf, get: passkeyPrf } });
