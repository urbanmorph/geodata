// @vitest-environment happy-dom
// "Your maps" on the landing builds its links from saved maps, which can arrive
// from a restored file or from sync. A crafted link must stay a link: escaped
// into the href, never markup.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/register-sw', () => ({}));
vi.mock('../../web/src/install-button', () => ({ mountInstallButton: () => {} }));
vi.mock('../src/passkey', () => ({ passkeysAvailable: () => false }));
vi.mock('../src/syncing', () => ({
  syncState: () => null, syncDevice: vi.fn(), setUpSync: vi.fn(), turnOffSync: vi.fn(),
  unlockWithPasskey: vi.fn(), startAutoSync: () => {}, SyncGone: class extends Error {},
}));
vi.mock('../src/send-queue', () => ({ queuedFor: async () => [], sendWhenOnline: () => {}, OUTBOX_CHANGED: 'x' }));

const EVIL = 'https://x/c/m1#edt_a"><img id="pwn" src=x onerror="alert(1)">';

beforeAll(async () => {
  localStorage.setItem('collect:maps', JSON.stringify([
    { id: 'm1', name: 'Trees', role: 'owner', links: { edit: EVIL, admin: EVIL }, at: '2026-11-01T00:00:00Z' },
  ]));
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ points: 0 })));
  window.scrollTo = () => {};
  await import('../src/landing');
});

describe('Your maps links', () => {
  it('put a saved link into the href as text, adding no elements', () => {
    expect(document.getElementById('pwn')).toBeNull();
    const hrefs = [...document.querySelectorAll<HTMLAnchorElement>('#mymaps a.btn')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([EVIL, EVIL]);
  });
});
