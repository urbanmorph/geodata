// Edge-rendered HTML for /c/[id] community submission view pages.
// Pure function so it unit-tests without a Pages Functions runtime.
// Stays light on purpose: no MapLibre, no Vite assets — just metadata,
// downloads, thumbs-up, and a "view on map" link that punts to /preview.
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

const PUBLIC_ORIGIN = 'https://bharatlas.com';

const LICENSE_URLS: Record<string, string> = {
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
  'ODbL-1.0': 'https://opendatacommons.org/licenses/odbl/1-0/',
  'ODC-PDDL-1.0': 'https://opendatacommons.org/licenses/pddl/1-0/',
  'GODL-India': 'https://data.gov.in/government-open-data-license-india',
};

const FORMAT_MIME: Record<string, string> = {
  geojson: 'application/geo+json',
  json: 'application/json',
  kml: 'application/vnd.google-earth.kml+xml',
  kmz: 'application/vnd.google-earth.kmz',
  parquet: 'application/x-parquet',
};

function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

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
  origin: string;
  ratingsCount: number;
  /** Deprecated: kept so the test suite + edge handler still build during
   *  the up/down vote rollout. The view JS fetches the actual myVote
   *  state from /api/c/:id/rate on page load. */
  alreadyRated: boolean;
  embed?: boolean;
  now?: Date;
};

export function renderViewPage(opts: RenderOpts): string {
  const { submission: s, ratingsCount, embed, now } = opts;
  void opts.alreadyRated;
  void opts.origin; // intentionally unused — see file header for why.
  // RELATIVE paths for everything the user might click — resolved by the
  // browser against the page's actual origin (5173 in dev, bharatlas.com in
  // prod). The ?url= form signals view-only to /preview so the publish CTA
  // stays hidden — you can't re-submit something already in the catalog.
  const r2Path = `/api/r2/${s.r2_key}`;
  const verifyUrl = `/preview?url=${encodeURIComponent(r2Path)}`;
  // CANONICAL paths for SEO/OG meta — always the public origin, never the
  // port-bound dev URL.
  const r2Url = `${PUBLIC_ORIGIN}/api/r2/${s.r2_key}`;
  const canonical = `${PUBLIC_ORIGIN}/c/${s.id}`;
  const licenseUrl = LICENSE_URLS[s.license] || s.license;
  const filename = s.r2_key.split('/').pop() || 'download';

  const description =
    s.description ||
    `Community-submitted geo layer on geodata: ${s.name}. ${s.feature_count ?? '—'} features, ${fmtBytes(s.bytes)}.`;
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

  const header = embed
    ? ''
    : `<header class="site-header">
      <a class="site-brand" href="/">bhar<span class="mark-accent">atlas</span><span class="tagline">· ${esc(s.name)}</span></a>
      <nav class="site-nav">
        <a href="/">catalog</a>
        <a href="/preview">contribute</a>
        <a href="/about">about</a>
      </nav>
    </header>`;

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
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}</script>
    <style>
      /* Edge-rendered — inlines the same tokens as scripts/shared-chrome.mjs.
         Keep in sync with that file. Vitest does NOT cover this string —
         the prerendered surfaces own the canonical tokens; this is a copy. */
      :root {
        --fs-xs: 11px; --fs-sm: 12px; --fs-md: 13px; --fs-base: 14px;
        --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 28px;
        --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
        --sp-5: 20px; --sp-6: 24px; --sp-7: 32px; --sp-8: 48px;
        --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px;
        --bg: #ffffff; --bg-card: #f5f5f5;
        --fg: #0a0a0a; --muted: #6b7280; --line: #e5e7eb;
        --accent: #6366f1; --accent-strong: #4f46e5;
        --accent-fill: #6366f1; --ok: #16a34a;
      }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #0a0a0a; --bg-card: #1a1a1f;
          --fg: #ededed; --muted: #9ca3af; --line: #262626;
          --accent: #818cf8; --accent-strong: #6366f1;
          --accent-fill: #6366f1; --ok: #4ade80; }
      }
      *, *::before, *::after { box-sizing: border-box; }
      html, body { margin: 0; background: var(--bg); color: var(--fg); }
      body { font: var(--fs-base)/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Inter", sans-serif;
        max-width: 720px; margin: 0 auto; padding: 28px 24px 64px; }
      a:focus-visible, button:focus-visible {
        outline: 2px solid var(--accent-strong) !important;
        outline-offset: 2px !important; border-radius: var(--radius-sm);
      }
      .site-header {
        display: flex; align-items: baseline; justify-content: space-between;
        gap: var(--sp-4); flex-wrap: wrap; margin-bottom: var(--sp-6);
      }
      .site-brand { font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.01em; color: var(--fg); text-decoration: none; }
      .site-brand .mark-accent { color: var(--accent); }
      .site-brand .tagline { color: var(--muted); font-weight: 400; margin-left: 6px; font-size: var(--fs-base); }
      .site-nav { display: flex; gap: var(--sp-3); flex-wrap: wrap; align-items: center; }
      .site-nav a { color: var(--muted); text-decoration: none; font-size: var(--fs-base); padding: 4px 0; }
      .site-nav a:hover { color: var(--fg); }
      .badge { display: inline-block; font-size: var(--fs-xs); font-weight: 600;
        padding: 2px 6px; border-radius: var(--radius-sm); letter-spacing: .04em; text-transform: uppercase;
        background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
      h2 { font-size: var(--fs-2xl); line-height: 1.2; margin: 4px 0 var(--sp-2); }
      .desc { color: var(--muted); margin: 0 0 var(--sp-6); }
      .kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px var(--sp-4); margin: var(--sp-4) 0 var(--sp-6); font-size: var(--fs-base); }
      .kv dt { color: var(--muted); }
      .kv dd { margin: 0; }
      .kv code { font: var(--fs-sm) ui-monospace, SFMono-Regular, Menlo, monospace; }
      .actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; margin: var(--sp-6) 0; }
      a.btn, button.btn {
        display: inline-block; padding: 9px 16px; border-radius: var(--radius-md);
        font: inherit; font-size: var(--fs-base); font-weight: 500; cursor: pointer;
        border: 1px solid var(--line); background: var(--bg); color: var(--fg); text-decoration: none;
      }
      a.btn.primary { background: var(--accent-fill); border-color: var(--accent-fill); color: #fff; }
      a.btn:hover, button.btn:hover { border-color: var(--accent); }
      button.btn:disabled { opacity: .55; cursor: default; border-color: var(--line); }
      .vote-useful { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: var(--radius-md); padding: 6px 12px; background: var(--bg); font: inherit; cursor: pointer; color: var(--muted); line-height: 1; min-height: 36px; }
      .vote-useful:hover { color: var(--fg); border-color: var(--accent); }
      .vote-useful[aria-pressed=true] { color: var(--accent); border-color: var(--accent); }
      .vote-useful .vote-count { font-weight: 600; font-variant-numeric: tabular-nums; }
      .vote-useful .vote-label { font-weight: 500; }
      .site-footer { margin-top: var(--sp-8); padding-top: var(--sp-5); border-top: 1px solid var(--line);
        font-size: var(--fs-sm); color: var(--muted); line-height: 1.6; }
      .site-footer a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; }
    </style>
  </head>
  <body data-submission-id="${esc(s.id)}">
    ${header}

    <span class="badge">community</span>
    <h2>${esc(s.name)}</h2>
    <p class="desc">${esc(description)}</p>

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
      <dd><code>${esc(s.format)}</code> · ${esc(fmtBytes(s.bytes))}${s.feature_count != null ? ` · ${s.feature_count.toLocaleString()} features` : ''}${s.geometry_types ? ` · ${esc(s.geometry_types)}` : ''}</dd>
      ${s.data_year ? `<dt>Data year</dt>
      <dd>${s.data_year}</dd>` : ''}
      <dt>Submitted</dt>
      <dd>${esc(relativeTime(s.created_at, now))}</dd>
    </dl>

    <div class="actions">
      <a class="btn primary" href="${esc(verifyUrl)}">View on map →</a>
      <a class="btn" href="${esc(r2Path)}" download="${esc(filename)}">Download <code>.${esc(s.format)}</code></a>
      <button class="vote-useful" id="vote-useful" type="button" aria-pressed="false">
        <span aria-hidden="true">👍</span>
        <span class="vote-count" id="vote-count">${ratingsCount}</span>
        <span class="vote-label">useful</span>
      </button>
    </div>

    <footer class="site-footer">
      <p>Anyone can submit a layer at <a href="/preview">/preview</a> — open licences only.
      All community submissions are auto-moderated; the platform doesn't vouch for accuracy.
      Verify provenance via the source link above.</p>
    </footer>

    <script>
      (() => {
        const id = document.body.dataset.submissionId;
        const btn = document.getElementById('vote-useful');
        const count = document.getElementById('vote-count');
        if (!btn || !count) return;

        // Display count = up votes only. Existing legacy downvotes in D1
        // are ignored in the UI per task #61 (single-direction Useful vote).
        let myVote = 0;
        const apply = (s) => {
          count.textContent = String(s.up || 0);
          myVote = s.myVote === 1 ? 1 : 0;
          btn.setAttribute('aria-pressed', myVote === 1 ? 'true' : 'false');
        };

        fetch('/api/c/' + id + '/rate').then(r => r.ok ? r.json() : null).then(s => s && apply(s)).catch(() => {});

        const send = async (vote) => {
          btn.disabled = true;
          try {
            const r = await fetch('/api/c/' + id + '/rate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ vote }),
            });
            if (r.ok) apply(await r.json());
          } catch {}
          btn.disabled = false;
        };
        // Click to mark useful; click again to clear.
        btn.addEventListener('click', () => send(myVote === 1 ? 0 : 1));
      })();
    </script>
  </body>
</html>`;
}
