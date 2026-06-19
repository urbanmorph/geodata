// Find-my-location flow: geolocate -> GET /api/v1/layers/{id}/locate -> render
// the result in the #locate-sheet. Lazy-loaded by map.ts when the user taps the
// Locate toolbar item; the result sheet is governed by the single-open overlay
// controller (scrim + close), so this module only owns its own content.

import { pickFeatureName } from './locate-format';
import type { LocateConfig } from './locate-config';

type LocateApiResponse = {
  mode: 'contains' | 'nearest';
  feature: { properties: Record<string, unknown> } | null;
  distance_km?: number;
  bearing?: string;
  out_of_coverage?: boolean;
};

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const PIN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';

export function openLocate(opts: {
  layerId: string;
  config: LocateConfig;
  sheet: HTMLElement;
  btn: HTMLElement;
  onClose: () => void;
}): void {
  const { layerId, config, sheet, btn, onClose } = opts;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  const stopPulse = () => btn.classList.remove('locating');

  const render = (html: string) => {
    sheet.innerHTML = `<button class="ls-close" type="button" aria-label="Close">×</button>${html}`;
    sheet.querySelector('.ls-close')?.addEventListener('click', onClose);
  };
  const msg = (t: string) => `<p class="ls-msg">${esc(t)}</p>`;
  const kicker = (t: string) => `<div class="ls-kicker">${PIN}<span>${esc(t)}</span></div>`;

  render(`<p class="ls-msg"><span class="ls-spinner"></span>Locating you…</p>`);

  if (!('geolocation' in navigator)) {
    stopPulse();
    render(msg("Your browser doesn't support location."));
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      stopPulse();
      const { latitude: lat, longitude: lng } = pos.coords;
      try {
        const r = await fetch(
          `/api/v1/layers/${encodeURIComponent(layerId)}/locate?lat=${lat}&lng=${lng}&mode=${config.mode}`,
        );
        if (r.status === 400) {
          // outside India bbox — the only 400 the endpoint returns for valid coords
          render(kicker('Outside coverage') +
            `<h2 class="ls-name">You're outside this layer's area</h2>` +
            `<p class="ls-sub">This data covers India.</p>`);
          return;
        }
        if (!r.ok) throw new Error(String(r.status));
        renderResult((await r.json()) as LocateApiResponse);
      } catch {
        render(msg("Couldn't look that up — try again."));
      }
    },
    (err) => {
      stopPulse();
      render(msg(err.code === err.PERMISSION_DENIED
        ? 'Location permission denied. Allow it in your browser to use this.'
        : "Couldn't get your location — try again outdoors."));
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );

  function renderResult(data: LocateApiResponse) {
    if (!data.feature) {
      render(kicker(data.mode === 'nearest' ? 'Nothing nearby' : 'Not found') +
        `<h2 class="ls-name">You're outside this layer's area</h2>` +
        `<p class="ls-sub">No feature ${data.mode === 'nearest' ? 'within range' : 'contains your location'} here.</p>`);
      return;
    }
    const name = pickFeatureName(data.feature.properties);
    const sub = data.mode === 'nearest' && data.distance_km != null
      ? `<p class="ls-sub"><span class="ls-dist">${data.distance_km} km${data.bearing ? ' ' + esc(data.bearing) : ''}</span></p>`
      : '';
    render(kicker(data.mode === 'nearest' ? 'Nearest to you' : 'You are here') +
      `<h2 class="ls-name">${esc(name)}</h2>${sub}`);
  }
}

export function closeLocate(sheet: HTMLElement): void {
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = '';
}
