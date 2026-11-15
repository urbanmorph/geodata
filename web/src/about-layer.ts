// The "About this layer" panel on the map screen: the answer first (what it
// is, how many, who published it, under which licence, when), then every
// download with its size and, for ward maps, the ward list. Pure HTML from the
// inlined catalog entry, so it works on a direct /view load and when a layer
// is opened from the home page. Reuses the server's ward table builder.
import { availableDownloads, fmtBytes } from './format-hints';
import { escapeHtml as esc, fmtDate } from '../../shared/format.mjs';
import { buildWardTable, type WardIndex } from '../functions/lib/view-dataset';
import { licenceUrl, isNonCommercial } from '../../shared/licences.mjs';

type Fmt = { url: string; bytes: number } | null | undefined;
export type AboutLayer = {
  id: string; source?: string; licence?: string; rows?: number | null; fetched_at?: string;
  description?: string; notes?: string;
  parquet?: Fmt; pmtiles?: Fmt; geojson?: Fmt; kml?: Fmt; shapefile?: Fmt;
};
export type AboutMeta = { label?: string; seo_title?: string; unit?: string; description?: string } | undefined;


function licenceBadge(licence: string): string {
  const nc = isNonCommercial(licence);
  const href = licenceUrl(licence);
  const link = href ? ` href="${esc(href)}" target="_blank" rel="noopener"` : '';
  return `<a class="lic-badge${nc ? ' lic-badge--nc' : ''}"${link}>${esc(licence)}</a>` +
    (nc ? ` <span class="lic-badge lic-badge--nc">Non-commercial only</span>` : '');
}

export function aboutLayerHtml({ layer, meta, wardIndex }: { layer: AboutLayer; meta: AboutMeta; wardIndex?: WardIndex | null }): string {
  const title = meta?.seo_title || meta?.label || layer.id.replace(/_/g, ' ');
  const facts = [
    layer.rows != null ? `<strong>${layer.rows.toLocaleString('en-IN')}</strong> ${esc(meta?.unit || 'features')}` : '',
    layer.source ? `Source: ${esc(layer.source)}` : '',
    layer.fetched_at ? `Updated <time datetime="${esc(layer.fetched_at.slice(0, 10))}">${fmtDate(layer.fetched_at)}</time>` : '',
  ].filter(Boolean).join(' · ');
  const desc = meta?.description || layer.description || layer.notes || '';
  const downloads = availableDownloads(layer);
  return `<h2 class="about-panel__title" id="about-title">${esc(title)}</h2>` +
    `<p class="about-panel__facts">${facts}</p>` +
    (layer.licence ? `<p class="about-panel__lic">${licenceBadge(layer.licence)}</p>` : '') +
    (desc ? `<p class="about-panel__desc">${esc(desc)}</p>` : '') +
    (downloads.length
      ? `<h3 class="about-panel__h">Download</h3><ul class="about-panel__dl">` +
        downloads.map((d) => `<li><a href="${esc(d.url)}" download><span>${esc(d.label)}</span><span class="about-panel__size">${esc(fmtBytes(d.bytes))}</span></a></li>`).join('') +
        `</ul>`
      : '') +
    buildWardTable(wardIndex).html;
}
