// "Your submissions" kept on all your devices: bharatlas's admin links, end to
// end encrypted, in their own keyring blob derived from the same secret (and
// unlocked by the same passkey) as collect's sync. The server can't read it.
import { describe, it, expect } from 'vitest';
import { deriveKeys, newSecret, type KeyringApi } from '../../shared/keyring';
import { createSubmissionSync, mergeSubmissions, SUBMISSIONS_LABEL, syncSecretFrom } from '../src/submission-sync';
import type { StoredSubmission } from '../src/my-submissions';

const sub = (id: string, created_at = 1): StoredSubmission => ({ id, name: `Layer ${id}`, token: `adm_${id}xxxxxxxx`, created_at, permission: 'admin' });

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k),
    clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
}

/** The keyring server (collect's /keyrings API), in memory. */
function fakeServer() {
  const rows = new Map<string, { blob: string; updated_at: string; writeKey: string }>();
  let clock = 0;
  const api: KeyringApi & { delete(id: string, writeKey: string): Promise<void> } = {
    async get(id) { const r = rows.get(id); return r ? { blob: r.blob, updated_at: r.updated_at } : null; },
    async put(id, writeKey, blob, base) {
      const r = rows.get(id);
      if (r && r.updated_at !== base) return { conflict: { blob: r.blob, updated_at: r.updated_at } };
      const updated_at = String(++clock);
      rows.set(id, { blob, updated_at, writeKey });
      return { updated_at };
    },
    async delete(id, writeKey) { if (rows.get(id)?.writeKey === writeKey) rows.delete(id); },
  };
  return { api, rows };
}

/** A device: its own storage, the shared server, and a passkey that yields fixed PRF bytes. */
function device(server: ReturnType<typeof fakeServer>, prf = new Uint8Array(32).fill(7)) {
  const storage = memoryStorage();
  const sync = createSubmissionSync({ api: server.api, storage, passkey: { create: async () => prf, get: async () => prf } });
  return { storage, sync };
}

describe('merging two devices\' lists', () => {
  it('keeps every submission from both, once, newest first', () => {
    const merged = mergeSubmissions([sub('a', 1), sub('b', 3)], [sub('b', 3), sub('c', 2)]);
    expect(merged.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('a separate keyring from collect\'s, from the same secret', () => {
  it('derives different keys, so bharatlas\'s links can never overwrite collect\'s maps', async () => {
    const secret = newSecret();
    const collect = await deriveKeys(secret);
    const subs = await deriveKeys(secret, SUBMISSIONS_LABEL);
    expect(subs.id).not.toBe(collect.id);
    expect(subs.writeKey).not.toBe(collect.writeKey);
  });
});

describe('keeping submission links on all your devices', () => {
  it('turned on here, joined there by the sync link: both have every link', async () => {
    const server = fakeServer();
    const laptop = device(server);
    laptop.sync.saveLocal(sub('a', 1));
    await laptop.sync.turnOn();
    const phone = device(server);
    phone.sync.saveLocal(sub('b', 2));
    const secret = syncSecretFrom(new URL(laptop.sync.link('https://bharatlas.com')!).hash)!;
    await phone.sync.join(secret);
    expect(phone.sync.list().map((s) => s.id)).toEqual(['b', 'a']);
    await laptop.sync.syncNow();
    expect(laptop.sync.list().map((s) => s.id)).toEqual(['b', 'a']);
    // What the server holds is ciphertext: no id, name or admin token in it.
    const stored = JSON.stringify([...server.rows.values()]);
    expect(stored).not.toContain('adm_a');
    expect(stored).not.toContain('Layer a');
  });

  it('a new device unlocks with the passkey and gets the same links', async () => {
    const server = fakeServer();
    const laptop = device(server);
    laptop.sync.saveLocal(sub('a'));
    await laptop.sync.turnOn();
    await laptop.sync.addPasskey();
    const tablet = device(server);
    await tablet.sync.unlockWithPasskey();
    expect(tablet.sync.list().map((s) => s.id)).toEqual(['a']);
  });

  it('the passkey made in collect (same secret) unlocks bharatlas\'s links too', async () => {
    const server = fakeServer();
    const prf = new Uint8Array(32).fill(9);
    const { storeWrappedSecret } = await import('../../shared/passkey');
    const secret = newSecret();
    await storeWrappedSecret(prf, secret, server.api); // what collect's "Add a passkey" stored
    const laptop = device(server, prf);
    await laptop.sync.unlockWithPasskey();
    expect(laptop.sync.state()!.secret).toBe(secret);
  });

  it('turning off deletes only bharatlas\'s copy: collect\'s sync and the passkey keep working', async () => {
    const server = fakeServer();
    const laptop = device(server);
    laptop.sync.saveLocal(sub('a'));
    await laptop.sync.turnOn();
    await laptop.sync.addPasskey();
    const before = server.rows.size; // bharatlas's copy + the passkey's wrapped secret
    await laptop.sync.turnOff();
    expect(server.rows.size).toBe(before - 1);
    expect(laptop.sync.state()).toBeNull();
    expect(laptop.sync.list().map((s) => s.id)).toEqual(['a']); // this device keeps its links
  });

  it('turned off on another device: this one stops, and does not quietly bring the copy back', async () => {
    const server = fakeServer();
    const laptop = device(server);
    await laptop.sync.turnOn();
    const phone = device(server);
    await phone.sync.join(laptop.sync.state()!.secret);
    await laptop.sync.turnOff();
    await expect(phone.sync.syncNow()).rejects.toThrow(/turned off/);
    expect(phone.sync.state()).toBeNull();
    expect(server.rows.size).toBe(0);
  });

  it('two devices saving at once both keep their link (the conflict is merged)', async () => {
    const server = fakeServer();
    const a = device(server);
    await a.sync.turnOn();
    const b = device(server);
    await b.sync.join(a.sync.state()!.secret);
    a.sync.saveLocal(sub('x', 5));
    b.sync.saveLocal(sub('y', 6));
    await a.sync.syncNow();
    await b.sync.syncNow(); // conflicts with a's write, merges, retries
    await a.sync.syncNow();
    expect(a.sync.list().map((s) => s.id)).toEqual(['y', 'x']);
  });
});
