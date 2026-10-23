// collect's side of the encrypted keyring ("Your maps"); the crypto, the sync
// loop and the server interface are shared with bharatlas (shared/keyring.ts).
import { mergeMaps, type SavedMap } from './maps-store';
import { sealJson, unsealJson, syncDoc, type KeyringKeys, type KeyringApi } from '../../shared/keyring';

export {
  b64url, fromB64url, newSecret, deriveKeys, deriveKeysFrom, sealJson, unsealJson, syncSecretFrom, SyncGone,
  type KeyringKeys, type KeyringApi,
} from '../../shared/keyring';

export function seal(encKey: CryptoKey, maps: SavedMap[]): Promise<string> {
  return sealJson(encKey, { v: 1, maps });
}

export async function unseal(encKey: CryptoKey, blob: string): Promise<SavedMap[]> {
  const doc = await unsealJson<{ v: number; maps: SavedMap[] }>(encKey, blob);
  if (doc.v !== 1 || !Array.isArray(doc.maps)) throw new Error('unknown keyring format');
  return doc.maps;
}

export function syncLink(origin: string, secret: string): string {
  return `${origin}/#sync=${secret}`;
}

// Pull, merge with this device's list, push (shared/keyring.ts syncDoc). Merging
// is a union (links and records per map), so nothing either device saved is lost.
export async function syncNow(
  keys: KeyringKeys, local: SavedMap[], api: KeyringApi, opts: { joined?: boolean } = {},
): Promise<{ maps: SavedMap[]; updated_at: string }> {
  const out = await syncDoc(keys, local, api, { seal, unseal, merge: mergeMaps }, opts);
  return { maps: out.value, updated_at: out.updated_at };
}
