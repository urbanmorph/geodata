// End-to-end encrypted keyring (opt-in sync of "Your maps" across devices, with
// no accounts). Everything here runs in the browser with WebCrypto:
//
//   secret   32 random bytes, base64url. Lives only on the user's devices and in
//            the fragment of their sync link (#sync=…), never sent to the server.
//   id       HKDF(secret, "collect-keyring-id"): which blob is theirs.
//   writeKey HKDF(secret, "collect-keyring-write"): proves they may update it
//            (the server keeps only its hash).
//   encKey   HKDF(secret, "collect-keyring-enc"): AES-GCM key for the blob.
//
// The server stores base64url(iv || ciphertext) and can neither read it nor
// tell whose it is.
import { mergeMaps, type SavedMap } from './maps-store';

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

export async function deriveKeys(secret: string): Promise<KeyringKeys> {
  if (!SECRET.test(secret)) throw new Error('bad keyring secret');
  return deriveKeysFrom(fromB64url(secret));
}

// Shared with the passkey path, which supplies 32 bytes from WebAuthn PRF
// instead of a stored secret.
export async function deriveKeysFrom(material: Uint8Array): Promise<KeyringKeys> {
  const base = await crypto.subtle.importKey('raw', material as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const id = [...(await hkdfBytes(base, 'collect-keyring-id', 16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const writeKey = b64url(await hkdfBytes(base, 'collect-keyring-write', 32));
  const encKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('collect-keyring-enc') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  return { id, writeKey, encKey };
}

export async function seal(encKey: CryptoKey, maps: SavedMap[]): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, enc.encode(JSON.stringify({ v: 1, maps }))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

export async function unseal(encKey: CryptoKey, blob: string): Promise<SavedMap[]> {
  const bytes = fromB64url(blob);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, encKey, bytes.slice(12));
  const doc = JSON.parse(new TextDecoder().decode(pt)) as { v: number; maps: SavedMap[] };
  if (doc.v !== 1 || !Array.isArray(doc.maps)) throw new Error('unknown keyring format');
  return doc.maps;
}

export function syncLink(origin: string, secret: string): string {
  return `${origin}/#sync=${secret}`;
}

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

// Pull, merge with this device's list, push. A 409 means another device wrote
// in between: merge what it wrote and try again. Merging is a union (links and
// records per map), so nothing either device saved is lost.
export async function syncNow(
  keys: KeyringKeys, local: SavedMap[], api: KeyringApi, opts: { joined?: boolean } = {},
): Promise<{ maps: SavedMap[]; updated_at: string }> {
  let remote = await api.get(keys.id);
  // A device that has synced before and finds no copy must not quietly create
  // a new one: the copy was deleted on purpose (or expired).
  if (!remote && opts.joined) throw new SyncGone('sync was turned off on another device');
  let maps = local;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (remote) maps = mergeMaps(await unseal(keys.encKey, remote.blob), maps);
    const res = await api.put(keys.id, keys.writeKey, await seal(keys.encKey, maps), remote?.updated_at ?? null);
    if ('updated_at' in res) return { maps, updated_at: res.updated_at };
    remote = res.conflict;
  }
  throw new Error('sync kept conflicting, try again');
}
