import { describe, it, expect } from 'vitest';
import { rpIdFor, storeWrappedSecret, recoverSecret } from '../src/passkey';
import { newSecret, type KeyringApi } from '../src/keyring';

function fakeServer(): KeyringApi & { rows: Map<string, { blob: string; updated_at: string }> } {
  const rows = new Map<string, { blob: string; updated_at: string }>();
  let clock = 0;
  return {
    rows,
    async get(id) { return rows.get(id) ?? null; },
    async put(id, _k, blob, base) {
      const cur = rows.get(id);
      if (cur && cur.updated_at !== base) return { conflict: cur };
      const updated_at = String(++clock);
      rows.set(id, { blob, updated_at });
      return { updated_at };
    },
  };
}
const prf = (n: number) => new Uint8Array(32).fill(n);

describe('rpIdFor — passkeys belong to bharatlas.com', () => {
  it('uses the registrable bharatlas.com domain on any bharatlas host', () => {
    expect(rpIdFor('collect.bharatlas.com')).toBe('bharatlas.com');
    expect(rpIdFor('bharatlas.com')).toBe('bharatlas.com');
  });
  it('falls back to the host itself elsewhere (local dev)', () => {
    expect(rpIdFor('localhost')).toBe('localhost');
  });
});

describe('passkey-wrapped sync secret', () => {
  it('the same passkey (same PRF output) recovers the secret on another device', async () => {
    const server = fakeServer();
    const s = newSecret();
    const handle = await storeWrappedSecret(prf(7), s, server);
    expect(handle.id).toMatch(/^[0-9a-f]{32}$/);
    expect([...server.rows.values()][0].blob).not.toContain(s); // ciphertext only
    expect(await recoverSecret(prf(7), server)).toEqual({ secret: s, handle });
  });
  it('a different passkey finds nothing', async () => {
    const server = fakeServer();
    await storeWrappedSecret(prf(7), newSecret(), server);
    expect(await recoverSecret(prf(8), server)).toBeNull();
  });
  it('re-adding the passkey on a device updates the stored secret', async () => {
    const server = fakeServer();
    await storeWrappedSecret(prf(7), newSecret(), server);
    const s2 = newSecret();
    await storeWrappedSecret(prf(7), s2, server);
    expect((await recoverSecret(prf(7), server))!.secret).toBe(s2);
  });
});
