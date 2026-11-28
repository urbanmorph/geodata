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

/** { name, line } for a requested layer, or null. */
export function requestedBy(layer) {
  const r = layer?.requested_by;
  const name = typeof r?.name === 'string' ? r.name.trim() : '';
  if (!name) return null;
  return { name, line: typeof r.line === 'string' ? r.line.trim() : '' };
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
  return `<div class="about-panel__req"><p class="about-panel__req-who">Curated by bharatlas at the request of ` +
    `${esc(r.name)}</p>` +
    (r.line ? `<p class="about-panel__req-line">${esc(r.line)}</p>` : '') +
    `<p class="about-panel__req-link"><a href="${REQUEST_URL}">Request a layer like this</a></p></div>`;
}

/** Ids of requested layers that are non-commercial (licence or flag): must always be empty. */
export function requestedLayersThatAreNonCommercial(layers) {
  return (layers || []).filter((l) => requestedBy(l) && layerIsNonCommercial(l)).map((l) => l.id);
}
