// @vitest-environment happy-dom
// A locate lookup that answers after its sheet closed (or another layer opened)
// must not draw into the sheet or zoom the map.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openLocate, closeLocate } from '../src/locate';

afterEach(() => vi.unstubAllGlobals());

const response = () =>
  new Response(JSON.stringify({ mode: 'contains', feature: { properties: { ward_name: 'Old ward' } } }), { status: 200 });

function deferredFetch() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/ward-index/')) return new Response('', { status: 404 });
    await gate;
    return response();
  }));
  return () => release();
}

describe('locate after close', () => {
  it('a late answer leaves the closed sheet empty and does not zoom', async () => {
    const release = deferredFetch();
    document.body.innerHTML = '<div id="s"></div><button id="b"></button>';
    const sheet = document.getElementById('s')!;
    const onZoom = vi.fn();
    openLocate({
      layerId: 'wards_a', config: { label: 'My ward', mode: 'contains' }, sheet,
      btn: document.getElementById('b')!, onZoom, coords: { lat: 12.9, lng: 77.5 }, onClose: () => {},
    });
    closeLocate(sheet);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(sheet.innerHTML).toBe('');
    expect(onZoom).not.toHaveBeenCalled();
  });
  it('a newer open owns the sheet', async () => {
    const release = deferredFetch();
    document.body.innerHTML = '<div id="s"></div><button id="b"></button>';
    const sheet = document.getElementById('s')!;
    const btn = document.getElementById('b')!;
    const first = vi.fn();
    openLocate({ layerId: 'wards_a', config: { label: 'My ward', mode: 'contains' }, sheet, btn, onZoom: first, coords: { lat: 12.9, lng: 77.5 }, onClose: () => {} });
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition: () => {} } });
    openLocate({ layerId: 'wards_b', config: { label: 'My ward', mode: 'contains' }, sheet, btn, onClose: () => {} });
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(first).not.toHaveBeenCalled();
    expect(sheet.textContent).toContain('Locating you');
  });
  it('a current answer still renders', async () => {
    const release = deferredFetch();
    document.body.innerHTML = '<div id="s"></div><button id="b"></button>';
    const sheet = document.getElementById('s')!;
    const onZoom = vi.fn();
    openLocate({ layerId: 'wards_a', config: { label: 'My ward', mode: 'contains' }, sheet, btn: document.getElementById('b')!, onZoom, coords: { lat: 12.9, lng: 77.5 }, onClose: () => {} });
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(sheet.textContent).toContain('Old ward');
    expect(onZoom).toHaveBeenCalledTimes(1);
  });
});
