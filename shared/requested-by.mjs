// A requested layer: someone asked for it (and paid for the curation), bharatlas curated it, and it is
// open to everyone. The list row says "Requested by <name>"; the About panel says "Curated by bharatlas at
// the request of <name>". Every non-community layer is curated by bharatlas, so a layer no one requested
// carries no credit line at all. A requested layer is paid work, so it never uses sources licensed for
// non-commercial use only: requestedLayersThatAreNonCommercial is the check (catalog test, and the
// pipeline refuses to register one).
import { escapeHtml as esc } from './format.mjs';
import { layerIsNonCommercial } from './licences.mjs';

export const REQUEST_URL = '/docs#request';

/** The request form, with a search that found nothing filled in. */
export function requestLayerUrl(q) {
  const t = String(q ?? '').trim();
  return t ? `/docs?q=${encodeURIComponent(t)}#request` : REQUEST_URL;
}

// An organisation may add a link (https only) and a logo. The logo is an SVG we host in
// web/public/requesters/, never loaded from the requester's site, and it sets its own dark-mode fill.
const LOGO = /^\/requesters\/[a-z0-9-]+\.svg$/;
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** { name, line, url, logo } for a requested layer (each of line, url, logo '' when not given), or null. */
export function requestedBy(layer) {
  const r = layer?.requested_by;
  const name = str(r?.name);
  if (!name) return null;
  const url = str(r.url);
  const logo = str(r.logo);
  return { name, line: str(r.line), url: /^https:\/\/[^\s"<>]+$/.test(url) ? url : '', logo: LOGO.test(logo) ? logo : '' };
}

/** The list row's tag, or '' when no one requested the layer. */
export function requestedByTagHtml(layer) {
  const r = requestedBy(layer);
  return r ? `<span class="badge req-badge">Requested by ${esc(r.name)}</span>` : '';
}

/** The About panel's credit block, or ''. */
export function requestedByAboutHtml(layer) {
  const r = requestedBy(layer);
  if (!r) return '';
  // The link is paid for, so it is marked sponsored. The name already says who, so the logo is decorative
  // (alt="") and not a second link to the same place.
  const who = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="sponsored noopener">${esc(r.name)}</a>` : esc(r.name);
  return `<div class="about-panel__req">` +
    (r.logo ? `<img class="about-panel__req-logo" src="${esc(r.logo)}" alt="" height="24" loading="lazy">` : '') +
    `<p class="about-panel__req-who">Curated by bharatlas at the request of <span class="about-panel__req-name">${who}</span></p>` +
    (r.line ? `<p class="about-panel__req-line">${esc(r.line)}</p>` : '') +
    `<p class="about-panel__req-link"><a href="${REQUEST_URL}">Request a layer like this</a></p></div>`;
}

/** /layers opens with the requested layers: each opens its map, with who asked. '' when none.
 *  labelOf gives a layer's title (the catalog's level label); the layer's name, then id, otherwise. */
export function requestedStripHtml(layers, labelOf = (l) => l.name || l.id) {
  const items = (layers || []).filter((l) => requestedBy(l));
  if (!items.length) return '';
  return `<section class="req-strip" id="requested" aria-labelledby="requested-title">` +
    `<h2 class="req-strip__title" id="requested-title">Requested layers</h2><div class="req-strip__list">` +
    items.map((l) => `<a class="req-strip__item" href="/view/${esc(l.id)}"><span class="req-strip__name">${esc(labelOf(l))}</span>` +
      `<span class="req-strip__by">Requested by ${esc(requestedBy(l).name)}</span></a>`).join('') +
    `</div></section>`;
}

/** A theme's levels with those holding a requested layer first (stable otherwise), so they are never folded away. */
export function requestedFirst(levels, byLevel) {
  const asked = (lvl) => (byLevel[lvl] || []).some((l) => requestedBy(l));
  return [...levels.filter(asked), ...levels.filter((lvl) => !asked(lvl))];
}

/** Ids of requested layers that are non-commercial (licence or flag): must always be empty. */
export function requestedLayersThatAreNonCommercial(layers) {
  return (layers || []).filter((l) => requestedBy(l) && layerIsNonCommercial(l)).map((l) => l.id);
}
