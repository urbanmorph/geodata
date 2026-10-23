import { describe, it, expect } from 'vitest';
import { newSecret, deriveKeys, seal, unseal, syncSecretFrom, syncLink } from '../src/keyring';
import type { SavedMap } from '../src/maps-store';

const maps: SavedMap[] = [{ id: 'm1', name: 'Trees', role: 'owner', links: { admin: 'https://x/c/m1/admin#adm_1' }, at: '2026-10-22' }];

describe('keyring secrets and keys', () => {
  it('a new secret is 32 random bytes in base64url', () => {
    const a = newSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(a);
  });
  it('derives a stable id and write key that are neither the secret nor each other', async () => {
    const s = newSecret();
    const k1 = await deriveKeys(s);
    const k2 = await deriveKeys(s);
    expect(k1.id).toMatch(/^[0-9a-f]{32}$/);
    expect(k1.writeKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([k2.id, k2.writeKey]).toEqual([k1.id, k1.writeKey]);
    expect(k1.writeKey).not.toBe(s);
    expect((await deriveKeys(newSecret())).id).not.toBe(k1.id);
  });
  it('rejects a malformed secret', async () => {
    await expect(deriveKeys('nope')).rejects.toThrow();
  });
});

describe('seal / unseal', () => {
  it('round-trips the maps and gives base64url ciphertext with a fresh IV each time', async () => {
    const { encKey } = await deriveKeys(newSecret());
    const a = await seal(encKey, maps);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toContain('adm_1');
    expect(await seal(encKey, maps)).not.toBe(a);
    expect(await unseal(encKey, a)).toEqual(maps);
  });
  it('fails with the wrong key or tampered ciphertext', async () => {
    const { encKey } = await deriveKeys(newSecret());
    const other = (await deriveKeys(newSecret())).encKey;
    const blob = await seal(encKey, maps);
    await expect(unseal(other, blob)).rejects.toThrow();
    const tampered = blob.slice(0, -2) + (blob.endsWith('AA') ? 'BB' : 'AA');
    await expect(unseal(encKey, tampered)).rejects.toThrow();
  });
});

describe('sync link', () => {
  it('carries the secret in the fragment only', () => {
    const s = newSecret();
    const link = syncLink('https://collect.bharatlas.com', s);
    expect(link).toBe(`https://collect.bharatlas.com/#sync=${s}`);
    expect(syncSecretFrom(new URL(link).hash)).toBe(s);
  });
  it('ignores other fragments', () => {
    expect(syncSecretFrom('')).toBeNull();
    expect(syncSecretFrom('#sync=short')).toBeNull();
    expect(syncSecretFrom('#other=1')).toBeNull();
  });
});

import { syncNow, SyncGone, type KeyringApi } from '../src/keyring';

// In-memory stand-in with the server's compare-and-set semantics (the real
// handlers are covered in tests/functions/keyring.test.ts).
function fakeServer(): KeyringApi & { writes: number } {
  const rows = new Map<string, { blob: string; updated_at: string }>();
  let clock = 0;
  return {
    writes: 0,
    async get(id) { return rows.get(id) ?? null; },
    async put(id, _key, blob, base) {
      const cur = rows.get(id);
      if (cur && cur.updated_at !== base) return { conflict: cur };
      const updated_at = String(++clock);
      rows.set(id, { blob, updated_at });
      this.writes++;
      return { updated_at };
    },
  };
}
const M = (id: string, records: string[] = []): SavedMap => ({
  id, name: id, role: 'collect', links: { edit: `E-${id}` }, records: records.map((r) => ({ id: r, label: r, link: `L-${r}`, at: 't' })), at: 't',
});

describe('syncNow', () => {
  it('two devices converge on the union of their maps and records', async () => {
    const server = fakeServer();
    const keys = await deriveKeys(newSecret());
    const a = await syncNow(keys, [M('m1', ['r1'])], server);
    const b = await syncNow(keys, [M('m1', ['r2']), M('m2')], server);
    const a2 = await syncNow(keys, a.maps, server);
    const ids = (maps: SavedMap[]) => maps.map((m) => `${m.id}:${(m.records ?? []).map((r) => r.id).sort().join(',')}`).sort();
    expect(ids(b.maps)).toEqual(['m1:r1,r2', 'm2:']);
    expect(ids(a2.maps)).toEqual(ids(b.maps));
  });
  it('retries after a conflict by merging what the other device wrote', async () => {
    const server = fakeServer();
    const keys = await deriveKeys(newSecret());
    await syncNow(keys, [M('m1')], server);
    const realPut = server.put.bind(server);
    let raced = false;
    server.put = async (id, key, blob, base) => {
      if (!raced) { raced = true; await realPut(id, key, await seal(keys.encKey, [M('m1'), M('other')]), base); }
      return realPut(id, key, blob, base);
    };
    const out = await syncNow(keys, [M('mine')], server);
    expect(out.maps.map((m) => m.id).sort()).toEqual(['m1', 'mine', 'other']);
  });
  it('a device that synced before treats a missing keyring as turned off, and does not re-create it', async () => {
    const server = fakeServer();
    const keys = await deriveKeys(newSecret());
    await expect(syncNow(keys, [M('m1')], server, { joined: true })).rejects.toBeInstanceOf(SyncGone);
    expect(server.writes).toBe(0);
  });
});

describe('collect\'s keys never change (devices already synced depend on them)', () => {
  it('a fixed secret still derives the same keyring id and write key', async () => {
    const k = await deriveKeys('A'.repeat(42) + 'Q');
    expect(k.id).toBe('7b0673d356ebeb5dcbd79a57676cf64e');
    expect(k.writeKey).toBe('UEanBxO3dGbN8Gvp-UfaPpgzYZ3y2aFg-5vrZW3yB4w');
  });
});

