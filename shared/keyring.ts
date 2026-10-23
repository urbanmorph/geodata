// End-to-end encrypted keyring: opt-in sync of a device's links across devices,
// with no accounts. Used by collect ("Your maps") and bharatlas ("Your
// submissions"). Everything here runs in the browser with WebCrypto:
//
//   secret   32 random bytes, base64url. Lives only on the user's devices and in
//            the fragment of their sync link (#sync=…), never sent to the server.
//   id       HKDF(secret, "<label>-id"): which blob is theirs.
//   writeKey HKDF(secret, "<label>-write"): proves they may update it (the
//            server keeps only its hash).
//   encKey   HKDF(secret, "<label>-enc"): AES-GCM key for the blob.
//
// Each app has its own label, so one secret (one sync link, one passkey) keeps a
// separate blob per app and neither can overwrite the other's. collect's label
// is "collect-keyring", fixed: devices already synced depend on it.
//
// The server stores base64url(iv || ciphertext) and can neither read it nor tell
// whose it is.

export const COLLECT_LABEL = 'collect-keyring';
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export interface KeyringKeys { id: string; writeKey: string; encKey: CryptoKey; }

async function hkdfBytes(base: CryptoKey, info: string, bytes: number): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, base, bytes * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveKeys(secret: string, label = COLLECT_LABEL): Promise<KeyringKeys> {
  if (!SECRET.test(secret)) throw new Error('bad keyring secret');
  return deriveKeysFrom(fromB64url(secret), label);
}

// Shared with the passkey path, which supplies 32 bytes from WebAuthn PRF
// instead of a stored secret.
export async function deriveKeysFrom(material: Uint8Array, label = COLLECT_LABEL): Promise<KeyringKeys> {
  const base = await crypto.subtle.importKey('raw', material as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const id = [...(await hkdfBytes(base, `${label}-id`, 16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const writeKey = b64url(await hkdfBytes(base, `${label}-write`, 32));
  const encKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`${label}-enc`) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  return { id, writeKey, encKey };
}

// AES-GCM over any JSON document: base64url(iv || ciphertext), fresh IV each time.
export async function sealJson(encKey: CryptoKey, doc: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, enc.encode(JSON.stringify(doc))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

export async function unsealJson<T>(encKey: CryptoKey, blob: string): Promise<T> {
  const bytes = fromB64url(blob);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, encKey, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

/** The secret in a sync link's fragment (#sync=…), if it is one. */
export function syncSecretFrom(hash: string): string | null {
  const m = /^#sync=([A-Za-z0-9_-]+)$/.exec(hash);
  return m && SECRET.test(m[1]) ? m[1] : null;
}

// Sync was turned off on another device (or the copy expired): stop here too.
export class SyncGone extends Error {}

// The server calls, injected so the merge logic is testable without a network.
export interface KeyringApi {
  get(id: string): Promise<{ blob: string; updated_at: string } | null>;
  put(id: string, writeKey: string, blob: string, base: string | null):
    Promise<{ updated_at: string } | { conflict: { blob: string; updated_at: string } }>;
}

/** How one app's list goes in and out of its blob, and how two copies combine. */
export interface KeyringCodec<T> {
  seal(encKey: CryptoKey, value: T): Promise<string>;
  unseal(encKey: CryptoKey, blob: string): Promise<T>;
  merge(remote: T, local: T): T;
}

// Pull, merge with this device's copy, push. A 409 means another device wrote
// in between: merge what it wrote and try again. Merging is a union, so nothing
// either device saved is lost.
export async function syncDoc<T>(
  keys: KeyringKeys, local: T, api: KeyringApi, codec: KeyringCodec<T>, opts: { joined?: boolean } = {},
): Promise<{ value: T; updated_at: string }> {
  let remote = await api.get(keys.id);
  // A device that has synced before and finds no copy must not quietly create
  // a new one: the copy was deleted on purpose (or expired).
  if (!remote && opts.joined) throw new SyncGone('sync was turned off on another device');
  let value = local;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (remote) value = codec.merge(await codec.unseal(keys.encKey, remote.blob), value);
    const res = await api.put(keys.id, keys.writeKey, await codec.seal(keys.encKey, value), remote?.updated_at ?? null);
    if ('updated_at' in res) return { value, updated_at: res.updated_at };
    remote = res.conflict;
  }
  throw new Error('sync kept conflicting, try again');
}

/** The keyring server (collect's /keyrings API) at `base`, plus delete, used to turn sync off. */
export interface KeyringServer extends KeyringApi {
  delete(id: string, writeKey: string): Promise<void>;
}

/** collect's /keyrings API over HTTP. It allows any origin, so bharatlas.com calls it at collect.bharatlas.com. */
export function keyringHttp(base: string): KeyringServer {
  const call = (id: string, writeKey: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (writeKey) headers.set('authorization', `Bearer ${writeKey}`);
    if (init?.body) headers.set('content-type', 'application/json');
    return fetch(`${base}/keyrings/${id}`, { ...init, headers });
  };
  return {
    async get(id) {
      const r = await call(id, '');
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`sync failed (HTTP ${r.status})`);
      return r.json();
    },
    async put(id, writeKey, blob, base_) {
      const r = await call(id, writeKey, { method: 'PUT', body: JSON.stringify({ blob, base: base_ }) });
      if (r.status === 409) return { conflict: await r.json() };
      if (r.status === 410) throw new SyncGone('sync was turned off on another device');
      if (!r.ok) throw new Error(`sync failed (HTTP ${r.status})`);
      return r.json();
    },
    async delete(id, writeKey) {
      const r = await call(id, writeKey, { method: 'DELETE' });
      if (!r.ok) throw new Error(`couldn't delete the synced copy (HTTP ${r.status})`);
    },
  };
}
