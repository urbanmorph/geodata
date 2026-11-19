// @vitest-environment happy-dom
// The first sync of a visit finishes whenever the network lets it. If the
// person has already opened "Make a new map", the half-filled wizard must stay;
// only the home screen's own lists are redrawn, and only while it is showing.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/register-sw', () => ({}));
vi.mock('../../web/src/install-button', () => ({ mountInstallButton: () => {} }));
vi.mock('../src/passkey', () => ({ passkeysAvailable: () => true }));
let finishSync: () => void = () => {};
vi.mock('../src/syncing', () => ({
  syncState: () => ({ secret: 's', passkey: { id: 'pk' }, synced_at: null }),
  syncDevice: () => new Promise<void>((r) => { finishSync = r; }),
  setUpSync: vi.fn(), turnOffSync: vi.fn(), unlockWithPasskey: vi.fn(), startAutoSync: () => {},
  SyncGone: class extends Error {},
}));
vi.mock('../src/send-queue', () => ({ queuedFor: async () => [], sendWhenOnline: () => {}, OUTBOX_CHANGED: 'x' }));

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ points: 0 })));
  window.scrollTo = () => {};
  await import('../src/landing');
});

const app = () => document.getElementById('app')!;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the first sync finishing', () => {
  it('leaves a half-filled "Make a new map" alone', async () => {
    app().querySelector<HTMLButtonElement>('#start')!.click();
    await vi.waitFor(() => expect(app().querySelector('h1')?.textContent).toBe('What are you mapping?'));
    finishSync();
    await flush(); await flush();
    expect(app().querySelector('h1')?.textContent).toBe('What are you mapping?');
  });
});

describe('loading the home screen', () => {
  // "Make a new map" is ~20 KB few visits use: fetched when it is tapped.
  it('does not load the create wizard up front', () => {
    const src = readFileSync(resolve(__dirname, '../src/landing.ts'), 'utf8');
    expect(src).not.toMatch(/^import[^\n]*'\.\/create\/wizard'/m);
    expect(src).toMatch(/import\('\.\/create\/wizard'\)/);
  });
});
