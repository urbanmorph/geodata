// @vitest-environment happy-dom
// The viewer's "loading map…" never hangs: when the map or a layer can't load,
// it turns into the reason (plainly, for a lost connection).
import { describe, it, expect } from 'vitest';
import { showLayerError } from '../src/layer-errors';

describe('showLayerError', () => {
  it('replaces the "loading map…" indicator with the reason', () => {
    document.body.innerHTML = '<div id="map"><div id="map-loading">loading map…</div></div>';
    showLayerError(document.getElementById('map')!, new TypeError('Failed to fetch dynamically imported module'), false);
    const shown = document.querySelectorAll('#map-loading');
    expect(shown).toHaveLength(1);
    expect(shown[0].textContent).toMatch(/^No connection: this layer needs the internet/);
  });
  it('adds one when there is none, and keeps a technical reason for other failures', () => {
    document.body.innerHTML = '<div id="map"></div>';
    showLayerError(document.getElementById('map')!, new Error('HTTP 500'), true);
    expect(document.getElementById('map-loading')!.textContent).toBe('failed to load layer: HTTP 500');
  });
});
