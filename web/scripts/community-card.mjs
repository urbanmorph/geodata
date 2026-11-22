// Decide a community card's "View map" target + download set, branching on
// whether the submission has been baked into the catalog by
// scripts/bake_community.py (a c_<id> provenance:'community' layer carrying
// parquet/pmtiles/geojson/kml blocks).
//
//   unbaked → lightweight path: the raw upload, opened in the /preview
//             drag-drop viewer, with a single raw download.
//   baked   → parity path: /view/c_<id>, the IDENTICAL full curated viewer
//             (same chrome, basemap, Filter & export), plus the multi-format
//             download strip curated cards show.
//
// Pure + side-effect free so prerender and a vitest can share it.

// Where a community submission entered the catalog, derived from what we already
// store (no per-source keys): a collect map stamps `collection_id` on publish; the
// bharatlas /submit form does not. MCP / API publishes go through collect's publish
// too, so they read as 'collect'. Shared by the community card + the ops-dashboard
// geodata tab so both count provenance the same way.
export function channelOf(s) {
  return s && s.collection_id ? 'collect' : 'form';
}
export const CHANNEL_LABEL = { collect: 'via collect', form: 'via the contribution form' };

import { viewMapLink, wholeFileBytes } from '../../shared/large-load.mjs';
import { escapeHtml as esc, fmtBytes } from '../../shared/format.mjs';
import { availableDownloads } from '../src/format-hints.ts';

export function communityCardActions(s, baked) {
  if (baked) {
    // The curated strip's formats, in its order, through the same counted links.
    const downloads = availableDownloads(baked).map(({ fmt, url, bytes }) => ({ fmt, url, size: bytes ?? null }));
    return { baked: true, viewUrl: `/view/${baked.id}`, downloads, loadBytes: wholeFileBytes(baked) };
  }

  // Unbaked: stream the raw object through the allowlisted /api/r2 proxy and
  // pipe the same url into the /preview viewer.
  const r2Path = `/api/r2/${s.r2_key}`;
  return {
    baked: false,
    viewUrl: `/preview?url=${encodeURIComponent(r2Path)}`,
    downloads: [{ fmt: s.format, url: r2Path, size: s.bytes ?? null, raw: true }],
    loadBytes: s.bytes ?? null,
  };
}

// Render the card's actions block (View pill + downloads). Shared by prerender
// and a vitest so the visual parity is one source of truth: the "View map"
// control is the SAME .btn-primary pill (shared .btn .btn--line) as curated rows in BOTH states, baked
// gets the curated dl-inline multi-format strip, unbaked the single raw button.
export function renderCommunityActions(s, baked) {
  const a = communityCardActions(s, baked);
  let dl;
  if (baked) {
    dl = `<span class="dl-inline">${a.downloads
      .map(
        (d, i) =>
          `${i > 0 ? '<span class="dot">·</span>' : ''}<a href="${esc(d.url)}"${d.fmt === 'pmtiles' ? '' : ' download'}>${esc(d.fmt)}</a><span class="size">${d.size != null ? fmtBytes(d.size) : ''}</span>`,
      )
      .join('')}</span>`;
  } else {
    const d = a.downloads[0];
    const filename = s.r2_key.split('/').pop() || `${s.id}.${s.format}`;
    dl = `<a class="btn btn--line comm-card__dl" href="${esc(d.url)}" download="${esc(filename)}">Download .${esc(s.format)}<span class="size">${d.size != null ? fmtBytes(d.size) : ''}</span></a>`;
  }
  return `<div class="comm-card__actions">
      ${viewMapLink(a.viewUrl, a.loadBytes, 'btn btn--line btn-primary', 'View map').replace(' btn-primary', ' btn-primary comm-card__view')}
      ${dl}
    </div>`;
}
