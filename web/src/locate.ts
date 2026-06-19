// Find-my-location flow: geolocate (or a shared ?at= coord) -> GET
// /api/v1/layers/{id}/locate -> render the result in the #locate-sheet, with
// Zoom-to-it (highlight + frame, via the onZoom callback into map.ts) and Share
// actions. The sheet is governed by the single-open overlay controller (scrim +
// close), so this module only owns its own content.

import { pickFeatureName } from './locate-format';
import type { LocateConfig } from './locate-config';
import { escapeHtml } from './util';
import { shareUrl } from './locate-actions';

type LocateApiResponse = {
  mode: 'contains' | 'nearest';
  feature: { properties: Record<string, unknown> } | null;
  feature_point?: { lat: number; lng: number };
  distance_km?: number;
  bearing?: string;
  out_of_coverage?: boolean;
};

const PIN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';

export function openLocate(opts: {
  layerId: string;
  config: LocateConfig;
  sheet: HTMLElement;
  btn: HTMLElement;
  onZoom?: (props: Record<string, unknown>, lng: number, lat: number) => void;
  coords?: { lat: number; lng: number };
  onClose: () => void;
}): void {
  const { layerId, config, sheet, btn, onZoom, coords, onClose } = opts;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  const stopPulse = () => btn.classList.remove('locating');

  const render = (html: string) => {
    sheet.innerHTML = `<button class="ls-close" type="button" aria-label="Close">×</button>${html}`;
    sheet.querySelector('.ls-close')?.addEventListener('click', onClose);
  };
  const msg = (t: string) => `<p class="ls-msg">${escapeHtml(t)}</p>`;
  // The result card is always kicker + name heading + optional sub line; only
  // the copy changes (a hit, a miss, or "outside coverage"). nameHtml/subHtml
  // are pre-escaped by the caller since each varies in what it wraps.
  const result = (kickerText: string, nameHtml: string, subHtml = '') =>
    render(`<div class="ls-kicker">${PIN}<span>${escapeHtml(kickerText)}</span></div>` +
      `<h2 class="ls-name">${nameHtml}</h2>${subHtml}`);

  render(`<p class="ls-msg"><span class="ls-spinner"></span>Locating you…</p>`);

  // Shared ?at= link: skip geolocation, use the supplied coords, auto-zoom.
  if (coords) {
    run(coords.lat, coords.lng, true);
    return;
  }

  if (!('geolocation' in navigator)) {
    stopPulse();
    render(msg("Your browser doesn't support location."));
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => run(pos.coords.latitude, pos.coords.longitude, false),
    (err) => {
      stopPulse();
      render(msg(err.code === err.PERMISSION_DENIED
        ? 'Location permission denied. Allow it in your browser to use this.'
        : "Couldn't get your location — try again outdoors."));
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );

  async function run(lat: number, lng: number, autoZoom: boolean) {
    stopPulse();
    try {
      const r = await fetch(
        `/api/v1/layers/${encodeURIComponent(layerId)}/locate?lat=${lat}&lng=${lng}&mode=${config.mode}`,
      );
      if (r.status === 400) {
        // outside India bbox — the only 400 the endpoint returns for valid coords
        result('Outside coverage', "You're outside this layer's area",
          `<p class="ls-sub">This data covers India.</p>`);
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      renderResult((await r.json()) as LocateApiResponse, lat, lng, autoZoom);
    } catch {
      render(msg("Couldn't look that up — try again."));
    }
  }

  function renderResult(data: LocateApiResponse, lat: number, lng: number, autoZoom: boolean) {
    const isNearest = data.mode === 'nearest';
    if (!data.feature) {
      result(isNearest ? 'Nothing nearby' : 'Not found', "You're outside this layer's area",
        `<p class="ls-sub">No feature ${isNearest ? 'within range' : 'contains your location'} here.</p>`);
      return;
    }
    const props = data.feature.properties;
    const name = pickFeatureName(props);
    const sub = isNearest && data.distance_km != null
      ? `<p class="ls-sub"><span class="ls-dist">${data.distance_km} km${data.bearing ? ' ' + escapeHtml(data.bearing) : ''}</span></p>`
      : '';
    // Zoom target: the feature for nearest (it's elsewhere); the user for
    // contains (they're inside it).
    const zp = isNearest && data.feature_point ? data.feature_point : { lat, lng };
    const actions = '<div class="ls-actions">' +
      (onZoom ? '<button type="button" class="ls-act ls-zoom primary">Zoom to it</button>' : '') +
      '<button type="button" class="ls-act ls-share">Share</button></div>';
    result(isNearest ? 'Nearest to you' : 'You are here', escapeHtml(name), sub + actions);

    const zoom = () => onZoom?.(props, zp.lng, zp.lat);
    sheet.querySelector('.ls-zoom')?.addEventListener('click', zoom);
    sheet.querySelector('.ls-share')?.addEventListener('click', () => share(lat, lng, name));
    if (autoZoom) zoom();
  }

  async function share(lat: number, lng: number, name: string) {
    const url = shareUrl(location.origin, layerId, lat, lng);
    // navigator.share / clipboard must run in this click gesture; call them
    // synchronously (the awaited promise resolving later is fine).
    if (navigator.share) {
      try { await navigator.share({ title: 'bharatlas', text: `${name} — bharatlas`, url }); }
      catch { /* user cancelled the share sheet */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      const b = sheet.querySelector<HTMLElement>('.ls-share');
      if (b) {
        const prev = b.textContent;
        b.textContent = 'Link copied';
        setTimeout(() => { if (b.textContent === 'Link copied') b.textContent = prev; }, 1600);
      }
    } catch { /* clipboard blocked — nothing else to offer */ }
  }
}

export function closeLocate(sheet: HTMLElement): void {
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = '';
}
