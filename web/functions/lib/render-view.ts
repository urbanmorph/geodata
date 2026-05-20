// Edge-rendered HTML for /c/[id] community submission view pages.
// Pure function so it unit-tests without a Pages Functions runtime.
// Stays light on purpose: no MapLibre, no Vite assets — just metadata,
// downloads, thumbs-up, and a "view on map" link that punts to /verify.

import type { SubmissionView } from './submissions';

const R2_BASE = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev';

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
  const { submission: s, origin, ratingsCount, embed, now } = opts;
  void opts.alreadyRated;
  const r2Url = `${R2_BASE}/${s.r2_key}`;
  const verifyUrl = `${origin}/verify?url=${encodeURIComponent(r2Url)}`;
  const canonical = `${origin}/c/${s.id}`;
  const licenseUrl = LICENSE_URLS[s.license] || s.license;
  const filename = s.r2_key.split('/').pop() || 'download';

  const description =
    s.description ||
    `Community-submitted geo layer on geodata: ${s.name}. ${s.feature_count ?? '—'} features, ${fmtBytes(s.bytes)}.`;

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: s.name,
    description,
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
      <a class="site-brand" href="/">bharat<span class="mark-accent">las</span><span class="tagline">· ${esc(s.name)}</span></a>
      <nav class="site-nav">
        <a href="/">catalog</a>
        <a href="/verify">verify</a>
        <a href="/submit">submit</a>
        <a href="/about">about</a>
      </nav>
    </header>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>${esc(s.name)} · geodata</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${esc(canonical)}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${esc(s.name)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${esc(s.name)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🗺%3C/text%3E%3C/svg%3E" />
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
      .vote-group { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: var(--radius-md); padding: 2px 6px; background: var(--bg); }
      .vote { background: transparent; border: 0; padding: 4px 6px; font: inherit; cursor: pointer; color: var(--muted); border-radius: var(--radius-sm); line-height: 1; }
      .vote:hover { color: var(--fg); background: var(--bg-card); }
      .vote[aria-pressed=true].vote-up { color: var(--accent); }
      .vote[aria-pressed=true].vote-down { color: #ef4444; }
      .vote-score { font-weight: 600; font-variant-numeric: tabular-nums; min-width: 18px; text-align: center; }
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
      <dt>Submitted</dt>
      <dd>${esc(relativeTime(s.created_at, now))}</dd>
    </dl>

    <div class="actions">
      <a class="btn primary" href="${esc(verifyUrl)}">View on map →</a>
      <a class="btn" href="${esc(r2Url)}" download="${esc(filename)}">Download <code>.${esc(s.format)}</code></a>
      <div class="vote-group" role="group" aria-label="vote on this submission">
        <button class="vote vote-up" id="vote-up" type="button" aria-pressed="false" aria-label="upvote">▲</button>
        <span class="vote-score" id="vote-score">${ratingsCount}</span>
        <button class="vote vote-down" id="vote-down" type="button" aria-pressed="false" aria-label="downvote">▼</button>
      </div>
    </div>

    <footer class="site-footer">
      <p>Anyone can submit a layer at <a href="/submit">/submit</a> — open licences only.
      All community submissions are auto-moderated; the platform doesn't vouch for accuracy.
      Verify provenance via the source link above.</p>
    </footer>

    <script>
      (() => {
        const id = document.body.dataset.submissionId;
        const upBtn = document.getElementById('vote-up');
        const downBtn = document.getElementById('vote-down');
        const score = document.getElementById('vote-score');
        if (!upBtn || !downBtn || !score) return;

        let myVote = 0;
        const apply = (s) => {
          score.textContent = String(s.score);
          myVote = s.myVote;
          upBtn.setAttribute('aria-pressed', s.myVote === 1 ? 'true' : 'false');
          downBtn.setAttribute('aria-pressed', s.myVote === -1 ? 'true' : 'false');
        };

        fetch('/api/c/' + id + '/rate').then(r => r.ok ? r.json() : null).then(s => s && apply(s)).catch(() => {});

        const send = async (vote) => {
          upBtn.disabled = true; downBtn.disabled = true;
          try {
            const r = await fetch('/api/c/' + id + '/rate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ vote }),
            });
            if (r.ok) apply(await r.json());
          } catch {}
          upBtn.disabled = false; downBtn.disabled = false;
        };
        // Cancel-on-opposite: if you've already voted (either way), clicking
        // any button clears your vote. Click again to set the new direction.
        upBtn.addEventListener('click', () => send(myVote === 0 ? 1 : 0));
        downBtn.addEventListener('click', () => send(myVote === 0 ? -1 : 0));
      })();
    </script>
  </body>
</html>`;
}
