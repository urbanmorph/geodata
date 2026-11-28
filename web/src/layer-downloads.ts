// /layers rows load their download links when opened, from the small file the
// build writes per row (/layer-dl/<row id>.json: each of the row's layers with
// the map's download list, sizes and baked counts). The page itself carries a
// link to the map page in their place, which is also what a reader without JS
// gets. One fetch per row; a failed one is tried again on the next open.
import { escapeHtml as esc, fmtBytes, fmtCount, fmtInt } from '../../shared/format.mjs';
import { patchDownloadCounts } from './live-counts';

/** One download of a layer, as the build writes it. */
export type RowDownload = { fmt: string; url: string; bytes: number | null; count: number };
/** /layer-dl/<row id>.json: layer id → its downloads, for every layer in the row. */
export type RowDownloads = Record<string, RowDownload[]>;

// The `download` and data-fmt attributes and /api/dl urls are what counting needs (live-counts.ts).
const anchor = (d: RowDownload): string =>
  `<a href="${esc(d.url)}" download data-fmt="${esc(d.fmt)}">${d.fmt === 'shapefile' ? 'shp' : esc(d.fmt)}</a>`;

/** The row's "Download:" line: each format with its size and count (the dots between are CSS). */
export function downloadsHtml(list: RowDownload[]): string {
  return `Download: <span class="dl-inline">${list
    .map((d) => `${anchor(d)}<span class="size">${fmtBytes(d.bytes)}</span>${d.count ? `<span class="count" title="${fmtInt(d.count)} downloads">${fmtCount(d.count)}</span>` : ''}`)
    .join('')}</span>`;
}

/** One layer's links in the "compare sources" list. */
export function altLinksHtml(list: RowDownload[]): string {
  return list.length ? list.map(anchor).join('<span class="dot">·</span>') : '<span class="muted">no downloads</span>';
}

const FAILED = 'The download links did not load. ';
const loads = new Map<string, Promise<void>>();

function loadRow(row: HTMLElement): Promise<void> {
  const known = loads.get(row.id);
  if (known) return known;
  // The "Download:" line (absent when only a compare-sources layer has files) and the compare slots.
  const p = row.querySelector<HTMLElement>('.row__downloads');
  const slots = row.querySelectorAll<HTMLElement>('.links[data-dl]');
  if (!p && !slots.length) return Promise.resolve();
  // The map-page link the page was built with, kept for a failure.
  const fallback = p?.querySelector('a[href^="/view/"]')?.outerHTML ?? '';
  p?.setAttribute('aria-busy', 'true');
  const load = fetch(`/layer-dl/${encodeURIComponent(row.id)}.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<RowDownloads>;
    })
    .then((file) => {
      const own = file[row.dataset.id || ''];
      if (p && !own) throw new Error('row not in its file');
      if (p) p.innerHTML = downloadsHtml(own);
      for (const el of slots) el.innerHTML = altLinksHtml(file[el.dataset.dl || ''] ?? []);
      // The baked counts show now; the live ones replace them when they arrive.
      patchDownloadCounts(row).catch(() => {});
    })
    .catch(() => {
      loads.delete(row.id);
      if (p) p.innerHTML = FAILED + fallback;
    })
    .finally(() => p?.removeAttribute('aria-busy'));
  loads.set(row.id, load);
  return load;
}

/** Load a row's links when its details open (a click, Enter, or opened already when wired). */
export function wireLazyDownloads(root: HTMLElement): void {
  const onOpen = (d: Element | null): void => {
    if (d instanceof HTMLDetailsElement && d.open && d.classList.contains('row__details')) {
      const row = d.closest<HTMLElement>('.row');
      if (row) void loadRow(row);
    }
  };
  // toggle does not bubble: listen in the capture phase.
  root.addEventListener('toggle', (e) => onOpen(e.target as Element), true);
  for (const d of root.querySelectorAll('details.row__details[open]')) onOpen(d);
}
