// @vitest-environment happy-dom
// Opening a sync link (#sync=<secret>) must never adopt its secret: joining would
// merge this device's map links, admin links among them, into a copy whoever
// made the link can read. The secret only leaves the address bar.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/register-sw', () => ({}));
vi.mock('../../web/src/install-button', () => ({ mountInstallButton: () => {} }));
vi.mock('../src/passkey', () => ({ passkeysAvailable: () => true }));
vi.mock('../src/send-queue', () => ({ queuedFor: async () => [], sendWhenOnline: () => {}, OUTBOX_CHANGED: 'x' }));

const SECRET = 'S'.repeat(43);
const fetches: string[] = [];

beforeAll(async () => {
  localStorage.setItem('collect:maps', JSON.stringify([
    { id: 'abcdef', name: 'Trees', role: 'owner', links: { admin: 'https://collect.bharatlas.com/c/abcdef/admin#adm_x' }, at: '2026-11-01T00:00:00Z' },
  ]));
  history.replaceState(null, '', `/#sync=${SECRET}`);
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('fetch', async (u: string) => { fetches.push(String(u)); return new Response(JSON.stringify({ points: 0 })); });
  window.scrollTo = () => {};
  await import('../src/landing');
  await new Promise((r) => setTimeout(r, 0));
});

describe('a sync link opened on collect', () => {
  it('is taken out of the address', () => {
    expect(location.hash).toBe('');
  });
  it('is not adopted: no sync state, no keyring request', () => {
    expect(localStorage.getItem('collect:keyring')).toBeNull();
    expect(fetches.some((u) => u.includes('/keyrings/'))).toBe(false);
  });
  it('points the person to their passkey instead', () => {
    expect(document.querySelector('#sync')?.textContent).toContain('Sync links no longer work');
  });
});
