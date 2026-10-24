// @vitest-environment happy-dom
// Sync, one way: a passkey. "Set up on this device" turns sync on and makes the
// passkey in one step (cancelled = nothing left half set up). "I've set this up
// already" unlocks the existing copy with the passkey and ADDS this device's
// maps to it, even on a device that had started its own separate copy (the
// trap two people hit: each device's "Turn on sync" made an unlinked copy).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const prf = new Uint8Array(32).fill(7);
vi.mock('../src/passkey', async (orig) => ({
  ...(await orig<typeof import('../src/passkey')>()),
  createPasskeyPrf: vi.fn(async () => prf),
  passkeyPrf: vi.fn(async () => prf),
}));

const store = new Map<string, { blob: string; updated_at: string }>();
let n = 0;
function fakeServer() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const id = String(url).split('/keyrings/')[1];
    const method = init.method ?? 'GET';
    if (method === 'GET') { const v = store.get(id); return v ? new Response(JSON.stringify(v)) : new Response('{}', { status: 404 }); }
    if (method === 'PUT') { const { blob } = JSON.parse(String(init.body)); const v = { blob, updated_at: `t${++n}` }; store.set(id, v); return new Response(JSON.stringify({ updated_at: v.updated_at })); }
    if (method === 'DELETE') { store.delete(id); return new Response('{}'); }
    return new Response('{}', { status: 405 });
  });
}
const map = (id: string) => ({ id, name: id, role: 'owner' as const, links: { admin: `https://c/c/${id}/admin#adm_${id}` }, at: '2026-10-24' });

beforeEach(() => {
  localStorage.clear(); store.clear(); vi.resetModules(); fakeServer();
});

describe('set up on this device', () => {
  it('turns sync on and adds the passkey in one step', async () => {
    const s = await import('../src/syncing');
    await s.setUpSync();
    expect(s.syncState()).toMatchObject({ secret: expect.any(String), passkey: { id: expect.any(String) } });
  });

  it('a cancelled passkey leaves nothing half set up', async () => {
    const pk = await import('../src/passkey');
    vi.mocked(pk.createPasskeyPrf).mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    const s = await import('../src/syncing');
    await expect(s.setUpSync()).rejects.toThrow();
    expect(s.syncState()).toBeNull();
    expect(store.size).toBe(0);
  });

  it('a device already syncing without a passkey keeps its copy and gains the passkey', async () => {
    const s = await import('../src/syncing');
    const ms = await import('../src/maps-store');
    ms.replaceMaps([map('old')]);
    await s.joinSync((await import('../src/keyring')).newSecret()); // an older, link-only copy
    const before = s.syncState()!.secret;
    await s.setUpSync();
    expect(s.syncState()).toMatchObject({ secret: before, passkey: expect.anything() });
  });
});

describe("I've set this up already", () => {
  it("adds this device's maps to the copy the passkey unlocks, even if this device had its own copy", async () => {
    // Phone: set up with a passkey, one map.
    let s = await import('../src/syncing');
    let ms = await import('../src/maps-store');
    ms.replaceMaps([map('phone-map')]);
    await s.setUpSync();
    await s.syncDevice();
    // iPad: a different device that had started its OWN copy, with the new map.
    localStorage.clear(); vi.resetModules();
    s = await import('../src/syncing'); ms = await import('../src/maps-store');
    ms.replaceMaps([map('ipad-map')]);
    await s.joinSync((await import('../src/keyring')).newSecret());
    await s.unlockWithPasskey();
    expect(ms.myMaps().map((m) => m.id).sort()).toEqual(['ipad-map', 'phone-map']);
    // and the phone gets the iPad's map on its next sync
    const ipadState = s.syncState()!;
    localStorage.clear(); vi.resetModules();
    s = await import('../src/syncing'); ms = await import('../src/maps-store');
    localStorage.setItem('collect:keyring', JSON.stringify({ secret: ipadState.secret, synced_at: 'x', passkey: ipadState.passkey }));
    await s.syncDevice();
    expect(ms.myMaps().map((m) => m.id).sort()).toEqual(['ipad-map', 'phone-map']);
  });
});
