// @vitest-environment happy-dom
// The guided "Make a new map" replaces only the create screens. Whatever path
// leaves it (Back on step 1, the top-bar arrow, after Ready), the home screen
// still has "Your maps on all your devices" (passkey sync), and the new map is
// saved and pushed to the other devices when sync is on.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/register-sw', () => ({}));
vi.mock('../../web/src/install-button', () => ({ mountInstallButton: () => {} }));
vi.mock('../src/passkey', () => ({ passkeysAvailable: () => true }));
const syncDevice = vi.fn(async () => {});
vi.mock('../src/syncing', () => ({
  syncState: () => ({ secret: 's', passkey: { id: 'pk' } }),
  syncDevice: () => syncDevice(),
  setUpSync: vi.fn(), joinSync: vi.fn(), turnOffSync: vi.fn(), unlockWithPasskey: vi.fn(),
  startAutoSync: () => window.addEventListener('collect:maps-changed', () => void syncDevice()),
  SyncGone: class extends Error {},
}));
vi.mock('../src/send-queue', () => ({ queuedFor: async () => [], sendWhenOnline: () => {}, OUTBOX_CHANGED: 'x' }));

const posts: Array<{ url: string; body: any }> = [];
beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method === 'POST') posts.push({ url, body });
    if (url.endsWith('/collections') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'map0000001', links: { edit: 'https://c/c/map0000001#edt_x', admin: 'https://c/c/map0000001/admin#adm_x', view: 'https://c/c/map0000001/view#viw_x' }, tokens: { admin: 'adm_x' } }));
    }
    if (url.endsWith('/tokens')) return new Response(JSON.stringify({ link: 'https://c/c/map0000001#edt_named', label: body.label }));
    return new Response(JSON.stringify({ points: 0 }));
  });
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  await import('../src/landing');
});

const app = () => document.getElementById('app')!;
const $ = <T extends HTMLElement>(sel: string) => app().querySelector<T>(sel)!;
const click = (sel: string) => $<HTMLElement>(sel).click();
const hasSync = () => /Your maps on all your devices/.test(app().textContent || '');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the guided create flow keeps the home screen whole', () => {
  it('home has the sync section to start with', () => {
    expect(hasSync()).toBe(true);
  });

  it('Back on step 1 returns home with the sync section', () => {
    click('#start');
    expect($('h1').textContent).toBe('What are you mapping?');
    click('#wz-back');
    expect(hasSync()).toBe(true);
  });

  it('the top-bar arrow on step 1 returns home too', () => {
    click('#start');
    click('#wz-back-top');
    expect(hasSync()).toBe(true);
  });

  it('walks the four steps to a new map, then Ready, then home with sync intact', async () => {
    click('#start');
    click('.choice[data-t="garbage"]');
    expect($('h1').textContent).toBe('What will people mark?');
    click('.choice[data-m="photos_ai"]');
    click('#wz-next');
    expect($('h1').textContent).toBe('What should people note?');
    expect(app().querySelectorAll('.sb-name').length).toBeGreaterThan(1);
    click('#wz-next');
    expect($('h1').textContent).toBe('Name your map');
    $<HTMLInputElement>('#name').value = 'Garbage spots in Ward 12';
    $<HTMLTextAreaElement>('#purpose').value = 'Photograph every garbage spot';
    click('#create');
    await flush(); await flush();

    const created = posts.find((p) => p.url.endsWith('/collections'))!;
    expect(created.body.schema_doc).toMatchObject({ geometry: ['point'], mode: 'photos_ai' });
    expect(created.body.schema_doc.fields[0].type).toBe('photo');
    expect($('h1').textContent).toBe('Garbage spots in Ward 12 is ready');
    expect(app().textContent).toMatch(/Sync is on/);
    expect(app().textContent).toMatch(/Manage → Share/);
    expect($('#rd-open').textContent).toBe('Skip for now, open the map');

    // Saved and pushed to the other devices.
    expect(JSON.parse(localStorage.getItem('collect:maps') || '[]').some((m: { id: string }) => m.id === 'map0000001')).toBe(true);
    expect(syncDevice).toHaveBeenCalled();

    $<HTMLInputElement>('#who').value = 'Aarushi';
    click('#invite');
    await flush(); await flush();
    expect(posts.at(-1)!.body).toEqual({ permission: 'edit', label: 'Aarushi' });
    expect($('#rd-open').textContent).toBe('Done, open the map');

    click('#rd-home');
    expect(hasSync()).toBe(true);
    expect(app().textContent).toMatch(/Garbage spots in Ward 12/);
  });
});
