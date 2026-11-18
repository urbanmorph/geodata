// When opening a map means downloading one whole file (a layer with no map
// tiles), and that file is large or slow on this connection, the reader is told
// before they click and asked before it loads. One rule for every layer, never
// a per-layer list (owner, 2026-11-18). Used by the build (/layers rows,
// community cards) and the browser (web/src/large-load.ts).
import { escapeHtml, fmtBytes } from './format.mjs';

export const LARGE_BYTES = 20 * 1024 * 1024;
export const SLOW_SECONDS = 8;

/** Size and, when the speed is known (Mbps), the time a whole-file load would take. */
export function loadCost(bytes, downlinkMbps) {
  if (!bytes) return { bytes: null, seconds: null, large: false };
  const seconds = downlinkMbps ? (bytes * 8) / (downlinkMbps * 1e6) : null;
  return { bytes, seconds, large: bytes > LARGE_BYTES || (seconds !== null && seconds > SLOW_SECONDS) };
}

/** Bytes the map must download whole to show a layer, or null when it has tiles. */
export function wholeFileBytes(layer) {
  if (layer?.pmtiles?.url) return null;
  return layer?.geojson?.url ? (layer.geojson.bytes ?? null) : null;
}

export const LARGE_VIEW_LABEL = 'View large map';
// Hourglass: slow to open. Stroke follows the text colour; decorative (the label says it).
export const LARGE_ICON = '<svg class="large-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M6 2h12M6 22h12M7 2c0 5 10 5 10 10S7 17 7 22M17 2c0 5-10 5-10 10s10 5 10 10"/></svg>';
export const largeViewNote = (bytes) => `Loads one ${fmtBytes(bytes)} file in full`;

/** The View map link. A whole-file layer carries its size (data-load-bytes) so the
 *  page can apply the speed rule; over the size rule it gets its own label and style. */
export function viewMapLink(href, bytes, cls, label) {
  const big = loadCost(bytes).large;
  const attrs = bytes ? ` data-load-bytes="${bytes}"` : '';
  if (!big) return `<a href="${escapeHtml(href)}" class="${cls}"${attrs}>${escapeHtml(label)}</a>`;
  const note = largeViewNote(bytes);
  return `<a href="${escapeHtml(href)}" class="${cls} ${cls}--large"${attrs} title="${escapeHtml(note)}" ` +
    `aria-label="${escapeHtml(`${LARGE_VIEW_LABEL}: ${note.charAt(0).toLowerCase()}${note.slice(1)}`)}">${LARGE_ICON}${LARGE_VIEW_LABEL}</a>`;
}

/** A text link to a map (e.g. an alternate source): over the size rule it keeps its
 *  text and gains the hourglass, with the size in its title and accessible name. */
export function inlineMapLink(href, bytes, text) {
  if (!loadCost(bytes).large) return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  const note = largeViewNote(bytes);
  return `<a href="${escapeHtml(href)}" class="link--large" data-load-bytes="${bytes}" title="${escapeHtml(note)}" ` +
    `aria-label="${escapeHtml(`${text}: ${note.charAt(0).toLowerCase()}${note.slice(1)}`)}">${LARGE_ICON}${escapeHtml(text)}</a>`;
}
