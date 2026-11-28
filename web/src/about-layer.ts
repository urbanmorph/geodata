// The "About this layer" panel on the map screen: the answer first (what it
// is, how many, who published it, under which licence, when), then every
// download with its size and, for ward maps, the ward list. Pure HTML from the
// inlined catalog entry, so it works on a direct /view load and when a layer
// is opened from the home page. Reuses the server's ward table builder.
import { availableDownloads, fmtBytes } from './format-hints';
import { escapeHtml as esc, fmtDate } from '../../shared/format.mjs';
import { buildWardTable, type WardIndex } from '../functions/lib/view-dataset';
import { licenceBadgeHtml, layerIsNonCommercial } from '../../shared/licences.mjs';
import { requestedByAboutHtml } from '../../shared/requested-by.mjs';

type Fmt = { url: string; bytes: number } | null | undefined;
export type AboutLayer = {
  id: string; source?: string; licence?: string; non_commercial?: boolean; rows?: number | null; fetched_at?: string;
  description?: string; notes?: string; requested_by?: { name?: string; line?: string; url?: string; logo?: string } | null;
  parquet?: Fmt; pmtiles?: Fmt; geojson?: Fmt; kml?: Fmt; shapefile?: Fmt;
};
export type AboutMeta = { description?: string } | undefined;

/** The layer's downloads as rows (format, size, what it opens in), Parquet
 *  marked recommended: the one list the About panel and the Download menu show. */
export function downloadListHtml(layer: AboutLayer): string {
  return availableDownloads(layer)
    .map((d) =>
      `<a class="map-popover__item" href="${esc(d.url)}" download>` +
      `<span class="map-popover__fmt">${esc(d.label)}${d.fmt === 'parquet' ? ' <em class="dl-rec">recommended</em>' : ''}</span>` +
      `<span class="map-popover__size">${esc(fmtBytes(d.bytes))}</span>` +
      `<span class="map-popover__hint">${esc(d.hint)}</span></a>`)
    .join('');
}

/** The heading: the layer's card title and count noun (layer-display.ts layerHeading). */
export function aboutLayerHtml({ layer, meta, heading, wardIndex }: {
  layer: AboutLayer; meta: AboutMeta; heading: { title: string; unit: string }; wardIndex?: WardIndex | null;
}): string {
  const facts = [
    layer.rows != null ? `<strong>${layer.rows.toLocaleString('en-IN')}</strong> ${esc(heading.unit)}` : '',
    layer.source ? `Source: ${esc(layer.source)}` : '',
    layer.fetched_at ? `Updated <time datetime="${esc(layer.fetched_at.slice(0, 10))}">${fmtDate(layer.fetched_at)}</time>` : '',
  ].filter(Boolean).join(' · ');
  const desc = meta?.description || layer.description || layer.notes || '';
  const downloads = downloadListHtml(layer);
  return `<h2 class="about-panel__title" id="about-title">${esc(heading.title)}</h2>` +
    `<p class="about-panel__facts">${facts}</p>` +
    // Filled live by map.ts from /api/v1/usage: downloads and API/MCP queries.
    `<p class="about-panel__usage" data-usage hidden></p>` +
    (layer.licence ? `<p class="about-panel__lic">${licenceBadgeHtml(layer.licence, layerIsNonCommercial(layer))}</p>` : '') +
    requestedByAboutHtml(layer) +
    (desc ? `<p class="about-panel__desc">${esc(desc)}</p>` : '') +
    (downloads ? `<h3 class="about-panel__h">Download</h3><div class="about-panel__dl">${downloads}</div>` : '') +
    // Its own slot: the ward list arrives later and fills just this (focus stays put).
    `<div data-ward-slot>${wardTableHtml(wardIndex)}</div>`;
}

/** The ward list (a ward map's index), or '' when there is none. */
export function wardTableHtml(wardIndex?: WardIndex | null): string {
  return buildWardTable(wardIndex).html;
}
