// Optional passkey unlock for keyring sync. A passkey's PRF extension returns
// 32 bytes that only that passkey (on the user's phone/laptop, synced by iCloud
// Keychain or Google Password Manager) can produce. Those bytes derive a second,
// tiny keyring that holds just the sync secret, encrypted like any other. So on
// a new device "Unlock with passkey" recovers the secret and joins the same sync.
//
// The server sees one more opaque blob. It never sees the credential, a name or
// an email; nothing is verified server-side because the PRF output itself is the
// proof (without it the blob can't be decrypted or overwritten).
//
// The passkey belongs to bharatlas.com (not collect.), so one passkey unlocks
// both collect's and bharatlas's sync (each derives its own keyring from the same
// secret). Its user name is generic, never a person's name. The name and PRF input
// were set when collect first used passkeys and stay fixed: changing them would
// make existing passkeys unlock nothing.
import { deriveKeysFrom, sealJson, unsealJson, type KeyringApi } from './keyring';

export const PASSKEY_NAME = 'bharatlas collect keyring';
// Fixed PRF input: the same passkey always yields the same 32 bytes for it.
const PRF_SALT = new TextEncoder().encode('bharatlas collect keyring v1');

export function rpIdFor(hostname: string): string {
  return hostname === 'bharatlas.com' || hostname.endsWith('.bharatlas.com') ? 'bharatlas.com' : hostname;
}

// Where the wrapped secret lives; kept on the device so "Turn off sync" can
// delete it too.
export interface PasskeyHandle { id: string; writeKey: string; }

export async function storeWrappedSecret(prf: Uint8Array, secret: string, api: KeyringApi): Promise<PasskeyHandle> {
  const k = await deriveKeysFrom(prf);
  const blob = await sealJson(k.encKey, { v: 1, secret });
  let base = (await api.get(k.id))?.updated_at ?? null;
  for (let i = 0; i < 3; i++) {
    const res = await api.put(k.id, k.writeKey, blob, base);
    if ('updated_at' in res) return { id: k.id, writeKey: k.writeKey };
    base = res.conflict.updated_at; // last writer wins: it's the same user's secret
  }
  throw new Error("couldn't save the passkey, try again");
}

export async function recoverSecret(prf: Uint8Array, api: KeyringApi): Promise<{ secret: string; handle: PasskeyHandle } | null> {
  const k = await deriveKeysFrom(prf);
  const row = await api.get(k.id);
  if (!row) return null;
  const doc = await unsealJson<{ v: number; secret: string }>(k.encKey, row.blob);
  return { secret: doc.secret, handle: { id: k.id, writeKey: k.writeKey } };
}

// ---- WebAuthn (browser only) -------------------------------------------------

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials;
}

const challenge = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

// Ask for the PRF output with an existing passkey (shows the OS passkey sheet).
export async function passkeyPrf(): Promise<Uint8Array> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      rpId: rpIdFor(location.hostname),
      challenge: challenge() as BufferSource,
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const out = (cred?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first;
  if (!out) throw new Error("this browser or passkey can't unlock sync; use your sync link instead");
  return new Uint8Array(out);
}

// Create a passkey, then get its PRF output (some authenticators return it at
// creation, others only on the first use).
export async function createPasskeyPrf(): Promise<Uint8Array> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpIdFor(location.hostname), name: 'bharatlas' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)) as BufferSource, name: PASSKEY_NAME, displayName: PASSKEY_NAME },
      challenge: challenge() as BufferSource,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const prf = (cred?.getClientExtensionResults() as PrfResults | undefined)?.prf;
  if (prf?.results?.first) return new Uint8Array(prf.results.first);
  if (prf && prf.enabled === false) throw new Error("this passkey can't be used to unlock sync; your sync link still works");
  return passkeyPrf();
}

