// Edge-rendered HTML for /c/[id] community submission view pages.
// Pure function so it unit-tests without a Pages Functions runtime.
// Stays light on purpose: no MapLibre, no Vite assets — just metadata,
// downloads, thumbs-up, and a "View map" link that punts to /preview.
//
// Origin handling: in production the request origin is bharatlas.com and
// everything's fine. In dev, vite forwards /c/* to wrangler on :8788 — so
// `request.url`'s origin reads ":8788" even though the user is on :5173.
// Strategy:
//   • Canonical + OG meta tags use the hardcoded PUBLIC_ORIGIN (bharatlas.com)
//     so SEO doesn't ever index a port-bound dev URL.
//   • User-facing internal links use RELATIVE paths — the browser resolves
//     against the page's actual origin (5173 in dev, bharatlas.com in prod).
// Result: no link the user can click jumps off 5173 in dev.

import type { SubmissionView } from './submissions';
import { MAP_TOKENS, renderNav } from '../../scripts/shared-chrome.mjs';
import { escapeHtml as esc, fmtBytes } from '../../../shared/format.mjs';
import { licenceUrl } from '../../../shared/licences.mjs';
import { footerHtml } from '../../../shared/footer.mjs';

const PUBLIC_ORIGIN = 'https://bharatlas.com';

const FORMAT_MIME: Record<string, string> = {
  geojson: 'application/geo+json',
  json: 'application/json',
  kml: 'application/vnd.google-earth.kml+xml',
  kmz: 'application/vnd.google-earth.kmz',
  parquet: 'application/x-parquet',
};

function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  const diffMs = now.getTime() - t;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export type RenderOpts = {
  submission: SubmissionView;
  /** Up-votes at render time; c-vote.js fetches the live tally and the
   *  visitor's own vote from /api/c/:id/rate on load. */
  ratingsCount: number;
  embed?: boolean;
  now?: Date;
};

export function renderViewPage(opts: RenderOpts): string {
  const { submission: s, ratingsCount, embed, now } = opts;
  // No origin option: see the file header for why links are relative.
  // RELATIVE paths for everything the user might click — resolved by the
  // browser against the page's actual origin (5173 in dev, bharatlas.com in
  // prod). The ?url= form signals view-only to /preview so the publish CTA
  // stays hidden — you can't re-submit something already in the catalog.
  // Each key segment encoded: a filename with "#" or "?" otherwise cut the link short (404).
  const keyPath = s.r2_key.split('/').map(encodeURIComponent).join('/');
  const r2Path = `/api/r2/${keyPath}`;
  const verifyUrl = `/preview?url=${encodeURIComponent(r2Path)}`;
  // CANONICAL paths for SEO/OG meta — always the public origin, never the
  // port-bound dev URL.
  const r2Url = `${PUBLIC_ORIGIN}${r2Path}`;
  const canonical = `${PUBLIC_ORIGIN}/c/${s.id}`;
  const licenseUrl = licenceUrl(s.license) ?? s.license;
  const filename = s.r2_key.split('/').pop() || 'download';

  const description =
    s.description ||
    `Community-submitted geo layer on bharatlas: ${s.name}. ${s.feature_count != null ? `${s.feature_count} features, ` : ''}${fmtBytes(s.bytes)}.`;
  // Google Dataset Search rejects descriptions under ~50 chars. Pad with a
  // contextual suffix so terse contributor-supplied descriptions still pass.
  const ldDescription = description.length >= 80
    ? description
    : `${description} Community-contributed map on bharatlas, India's open atlas. Licence: ${s.license}.`;

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: s.name,
    description: ldDescription,
    url: canonical,
    license: licenseUrl,
    dateCreated: s.created_at,
    creator: { '@type': 'Person', name: s.attribution },
    isAccessibleForFree: true,
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: FORMAT_MIME[s.format] || 'application/octet-stream',
        contentUrl: r2Url,
        contentSize: String(s.bytes),
      },
    ],
    spatialCoverage: { '@type': 'Place', name: 'India' },
  };

  // The site's own header (shared-chrome), minus the /src install script.
  const header = embed ? '' : renderNav('community', { installScript: false });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>${esc(s.name)} · bharatlas</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${esc(canonical)}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${esc(s.name)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta property="og:image" content="${PUBLIC_ORIGIN}/og/c/${esc(s.id)}.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:site_name" content="bharatlas" />
    <meta property="og:locale" content="en_IN" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(s.name)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${PUBLIC_ORIGIN}/og/c/${esc(s.id)}.png" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}</script>
    <style>
      /* Edge-rendered with the site's shared tokens, header and page classes
         (scripts/shared-chrome.mjs); only this page's own pieces are below. */
      ${MAP_TOKENS}
      .tag { margin: var(--sp-2) 0 0; }
      .kv { display: grid; grid-template-columns: max-content 1fr; gap: var(--sp-2) var(--sp-5); margin: 0 0 var(--sp-6); font-size: var(--fs-base); }
      .kv dt { color: var(--muted); font: var(--fs-sm) var(--font-mono); }
      .kv dd { margin: 0; overflow-wrap: anywhere; }
      .actions { display: flex; gap: var(--sp-2-5); flex-wrap: wrap; align-items: center; margin: var(--sp-6) 0; }
      .vote-useful[aria-pressed=true] { background: color-mix(in srgb, var(--accent-fill) 22%, var(--bg-elevated)); }
      .vote-useful .vote-count { font-weight: 650; font-variant-numeric: tabular-nums; }
      @media (max-width: 640px) { .kv { grid-template-columns: 1fr; gap: var(--sp-0-5); } .kv dd { margin-bottom: var(--sp-2); } }
    </style>
  </head>
  <body class="page" data-submission-id="${esc(s.id)}">
    ${header}
    <main id="main" class="prose sheet">
    <p class="tag badge badge--stable">Community layer</p>
    <h1 class="page-title">${esc(s.name)}</h1>
    <p class="page-lead">${esc(description)}</p>

    <dl class="kv">
      ${s.is_original
        ? `<dt>Type</dt>
      <dd>Original work by ${esc(s.attribution)}</dd>${s.source_url ? `
      <dt>Method</dt>
      <dd>${esc(s.source_url)}</dd>` : ''}`
        : `<dt>Source</dt>
      <dd><a href="${esc(s.source_url)}" rel="noopener" target="_blank">${esc(s.source_url)}</a></dd>
      <dt>Attribution</dt>
      <dd>${esc(s.attribution)}</dd>`}
      <dt>Licence</dt>
      <dd><a href="${esc(licenseUrl)}" rel="noopener" target="_blank"><code>${esc(s.license)}</code></a></dd>
      <dt>Format</dt>
      <dd><code>${esc(s.format)}</code> · ${esc(fmtBytes(s.bytes))}${s.feature_count != null ? ` · ${s.feature_count.toLocaleString('en-IN')} features` : ''}${s.geometry_types ? ` · ${esc(s.geometry_types)}` : ''}</dd>
      ${s.data_year ? `<dt>Data year</dt>
      <dd>${s.data_year}</dd>` : ''}
      <dt>Submitted</dt>
      <dd>${esc(relativeTime(s.created_at, now))}</dd>
    </dl>

    <div class="actions">
      <a class="btn btn--fill" href="${esc(verifyUrl)}">View map</a>
      <a class="btn btn--line" href="${esc(r2Path)}" download="${esc(filename)}">Download .${esc(s.format)}</a>
      <button class="btn btn--line vote-useful" id="vote-useful" type="button" aria-pressed="false">
        <span aria-hidden="true">👍</span>
        <span class="vote-count" id="vote-count">${ratingsCount}</span>
        <span class="vote-label">useful</span>
      </button>
    </div>

    </main>
    ${footerHtml({ note: "A community layer: bharatlas doesn't vouch for its accuracy, so check it against the source link above. Anyone can add a layer under an open licence." })}

    <script src="/c-vote.js" defer></script>
  </body>
</html>`;
}
