// Decide a community card's "View on map" target + download set, branching on
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

// Route an R2 public url through the same-origin /api/dl counter, except
// pmtiles, which the viewer range-reads directly. Mirrors prerender's dlUrl().
export function dlProxyUrl(r2Url, fmt) {
  if (!r2Url) return r2Url;
  if (fmt === 'pmtiles') return r2Url;
  const m = r2Url.match(/^https?:\/\/[^/]+\/(.+)$/);
  return m ? `/api/dl/${m[1]}` : r2Url;
}

// Curated download order: data-first (parquet), then tiles, then the
// human-portable formats. Mirrors the curated card's strip.
const BAKED_FORMATS = ['parquet', 'pmtiles', 'geojson', 'kml'];

export function communityCardActions(s, baked) {
  if (baked) {
    const downloads = [];
    for (const fmt of BAKED_FORMATS) {
      const obj = baked[fmt];
      if (obj?.url) downloads.push({ fmt, url: dlProxyUrl(obj.url, fmt), size: obj.bytes ?? null });
    }
    return { baked: true, viewUrl: `/view/${baked.id}`, downloads };
  }

  // Unbaked: stream the raw object through the allowlisted /api/r2 proxy and
  // pipe the same url into the /preview viewer.
  const r2Path = `/api/r2/${s.r2_key}`;
  return {
    baked: false,
    viewUrl: `/preview?url=${encodeURIComponent(r2Path)}`,
    downloads: [{ fmt: s.format, url: r2Path, size: s.bytes ?? null, raw: true }],
  };
}

// Render the card's actions block (View pill + downloads). Shared by prerender
// and a vitest so the visual parity is one source of truth: the "View map"
// control is the SAME .btn-primary pill as curated rows in BOTH states, baked
// gets the curated dl-inline multi-format strip, unbaked the single raw button.
// `esc`/`fmtBytes` are injected to avoid duplicating prerender's helpers.
export function renderCommunityActions(s, baked, { esc, fmtBytes }) {
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
    dl = `<a class="btn comm-card__dl" href="${esc(d.url)}" download="${esc(filename)}">Download .${esc(s.format)}<span class="size">${d.size != null ? fmtBytes(d.size) : ''}</span></a>`;
  }
  return `<div class="comm-card__actions">
      <a class="btn-primary comm-card__view" href="${esc(a.viewUrl)}">View map →</a>
      ${dl}
    </div>`;
}
