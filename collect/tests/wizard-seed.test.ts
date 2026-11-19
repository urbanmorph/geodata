// @vitest-environment happy-dom
// "Start from a spreadsheet": the map is created, then its rows are imported.
// The admin link is shown once and only kept in Your maps, so it is saved the
// moment the map exists, before a long import that a phone may cut short. Each
// row carries a client_id, so importing the same rows again adds nothing.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../src/register-sw', () => ({}));
vi.mock('../../web/src/install-button', () => ({ mountInstallButton: () => {} }));
vi.mock('../src/passkey', () => ({ passkeysAvailable: () => false }));
vi.mock('../src/syncing', () => ({
  syncState: () => null, syncDevice: vi.fn(), setUpSync: vi.fn(), turnOffSync: vi.fn(), unlockWithPasskey: vi.fn(),
  startAutoSync: () => {}, SyncGone: class extends Error {},
}));
vi.mock('../src/send-queue', () => ({ queuedFor: async () => [], sendWhenOnline: () => {}, OUTBOX_CHANGED: 'x' }));

const LINKS = { edit: 'https://collect.bharatlas.com/c/map0000001#edt_x', admin: 'https://collect.bharatlas.com/c/map0000001/admin#adm_x', view: 'https://collect.bharatlas.com/c/map0000001/view#viw_x' };
let imports: Array<{ records: Array<{ client_id?: string }> }> = [];
let savedWhenImportStarted: boolean | null = null;

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/collections') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'map0000001', links: LINKS, tokens: { admin: 'adm_x' } }));
    }
    if (url.endsWith('/import')) {
      savedWhenImportStarted ??= (localStorage.getItem('collect:maps') || '').includes('map0000001');
      const body = JSON.parse(String(init!.body));
      imports.push(body);
      return new Response(JSON.stringify({ imported: body.records.length, added: body.records.length, total: body.records.length, errors: [] }));
    }
    return new Response(JSON.stringify({ points: 0 }));
  });
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  await import('../src/landing');
});

const app = () => document.getElementById('app')!;
const $ = <T extends HTMLElement>(sel: string) => app().querySelector<T>(sel)!;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const CSV = 'name,lng,lat\nNeem,77.59,12.97\nNeem,77.59,12.97\nPeepal,77.6,12.98\n';

async function createFromCsv(): Promise<void> {
  $<HTMLButtonElement>('#start').click(); // the wizard is loaded when tapped
  await vi.waitFor(() => expect(app().querySelector('#seed-file')).toBeTruthy());
  const input = $<HTMLInputElement>('#seed-file');
  Object.defineProperty(input, 'files', { value: [new File([CSV], 'trees.csv', { type: 'text/csv' })], configurable: true });
  input.dispatchEvent(new Event('change'));
  await flush();
  $<HTMLButtonElement>('#wz-next').click(); // how people mark
  $<HTMLButtonElement>('#wz-next').click(); // the questions
  $<HTMLInputElement>('#name').value = 'Trees';
  $<HTMLTextAreaElement>('#purpose').value = 'Mark trees';
  $<HTMLInputElement>('#seed-source').value = 'Ward survey 2026';
  $<HTMLInputElement>('#seed-rights').checked = true;
  $<HTMLButtonElement>('#create').click();
  await flush();
}

describe('creating a map from a spreadsheet', () => {
  it('saves the map to Your maps before importing its rows', async () => {
    await createFromCsv();
    expect(imports).toHaveLength(1);
    expect(savedWhenImportStarted).toBe(true);
  });
  it('gives every row a client_id, the same for the same row, distinct for a repeated one', () => {
    const ids = imports[0].records.map((r) => r.client_id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });
  it("shows the admin link to keep by hand when this device can't save the map", async () => {
    $<HTMLAnchorElement>('#rd-home').click();
    localStorage.clear();
    const real = localStorage.setItem.bind(localStorage);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
      if (k === 'collect:maps') throw new DOMException('full', 'QuotaExceededError');
      return real(k, v);
    });
    await createFromCsv();
    spy.mockRestore();
    expect(app().textContent).not.toMatch(/Saved to Your maps/);
    expect(app().querySelector('.warn')?.textContent).toMatch(/couldn't save this map/i);
    expect(app().querySelector('.share-item code')?.textContent).toBe(LINKS.admin);
  });
});
