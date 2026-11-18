// /releases and /releases/<dataset>: the release index (web/public/releases/index.json,
// written by scripts/release.py) as pages in the site's chrome. Emitted by vite.config.ts
// at build time (dist/releases.html, dist/releases/<dataset>.html), like the 404 page,
// so they leave no generated file in the tree. functions/releases serves them; the JSON
// stays at /releases/index.json and /api/v1/releases.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKENS, renderNav, FOOTER } from './shared-chrome.mjs';
import { fillTemplate } from './fill-template.mjs';
import { escapeHtml as esc, fmtBytes, fmtDate, fmtInt } from '../../shared/format.mjs';

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'releases.template.html');
const ORIGIN = 'https://bharatlas.com';

const bare = (url) => String(url).replace(/^https?:\/\//, '');
const version = (code) => code.slice(code.lastIndexOf('-') + 1);
const pair = (k, v) => `<li><span class="k">${k}</span><span>${v}</span></li>`;
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** {dataset: [release, ...]} newest first, datasets by their newest release (newest first). */
function byDataset(index) {
  const out = new Map();
  for (const r of index.releases || []) {
    if (!out.has(r.dataset)) out.set(r.dataset, []);
    out.get(r.dataset).push(r);
  }
  for (const list of out.values()) list.sort((a, b) => b.code.localeCompare(a.code));
  return new Map([...out].sort(([a, x], [b, y]) => y[0].released.localeCompare(x[0].released) || a.localeCompare(b)));
}

function head({ title, description, path }) {
  const url = ORIGIN + path;
  const full = `${title} · bharatlas`;
  return [
    `<title>${esc(full)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${esc(full)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:site_name" content="bharatlas" />`,
  ].join('\n    ');
}

function page(seo, main) {
  return fillTemplate(readFileSync(TEMPLATE, 'utf8'), {
    SEO_HEAD: head(seo), TOKENS, NAV: renderNav('', { installScript: false }), FOOTER, MAIN: main,
  });
}

const w3idLink = (r) => `<a href="${esc(r.w3id_proposed)}">${esc(bare(r.w3id_proposed))}</a>`;

/** The /releases page: every dataset, its newest release and how to cite one. */
export function renderReleasesIndex(index, layerIds = new Set()) {
  const groups = byDataset(index);
  const sections = [...groups].map(([ds, list]) => {
    const r = list[0];
    return `      <section>
        <h2><a href="/releases/${esc(ds)}">${esc(r.title)}</a></h2>
        <ul class="pairs">
          ${pair('Newest', `<a href="/releases/${esc(ds)}#${esc(r.code)}"><code>${esc(r.code)}</code></a>, ${fmtDate(r.released)}`)}
          ${pair('Cite as', w3idLink(r))}
          ${pair('Releases', `<a href="/releases/${esc(ds)}">${plural(list.length, 'release')}</a>`)}
          ${layerIds.has(ds) ? pair('Layer', `<a href="/view/${esc(ds)}">See it on the map</a>`) : ''}
        </ul>
      </section>`;
  });
  const example = [...groups.values()][0]?.[0];
  const main = `      <h1 class="page-title">Releases</h1>
      <p class="page-lead">Dated copies of bharatlas data that never change. Each release has a code, a SHA-256 pin of its files and a w3id.org address, so a paper, notebook or app can cite exactly the data it used.</p>
      <section>
        <h2>How to cite</h2>
        <div>
          <p>Cite the release code and its address${example ? `, for example ${w3idLink(example)}` : ''}. The address always leads to the same files; a correction goes in the next month's release.</p>
          <p>To check a copy, download the release's <code>SHA256SUMS</code> and run <code>sha256sum -c SHA256SUMS</code>. Running <code>sha256sum SHA256SUMS</code> gives the SHA-256 in the pin.</p>
          <p>For scripts: <a href="/releases/index.json">/releases/index.json</a> or <a href="/api/v1/releases">/api/v1/releases</a>.</p>
        </div>
      </section>
${sections.join('\n')}`;
  return page({
    title: 'Releases',
    description: `Dated, unchanging releases of bharatlas data, each with a SHA-256 pin and a permanent address to cite: ${plural(groups.size, 'dataset')}.`,
    path: '/releases',
  }, main);
}

function fileItem(f) {
  const facts = [fmtBytes(f.bytes), f.rows != null ? `${fmtInt(f.rows)} rows` : '', f.licence ? esc(f.licence) : '']
    .filter(Boolean).join(' · ');
  return `<li><a class="rel-name" href="${esc(f.url)}">${esc(f.name)}</a>`
    + `<span class="rel-sub">${facts}</span>`
    + `<span class="rel-sub">SHA-256 <code class="rel-hash">${esc(f.sha256)}</code></span></li>`;
}

function releaseSection(r) {
  const base = `/releases/${esc(r.code)}`;
  const files = r.files?.length ? `<ul class="rel-files">${r.files.map(fileItem).join('')}</ul>` : '';
  return `      <section id="${esc(r.code)}">
        <h2>${esc(version(r.code))}</h2>
        <ul class="pairs">
          ${pair('Code', `<code>${esc(r.code)}</code>`)}
          ${pair('Released', fmtDate(r.released))}
          ${pair('Cite as', w3idLink(r))}
          ${pair('SHA-256 pin', `<code class="rel-hash">${esc(r.pin)}</code>`)}
          ${pair('Previous', r.previous ? `<a href="#${esc(r.previous)}"><code>${esc(r.previous)}</code></a>` : 'None: the first release')}
        </ul>
        ${files}
        <p class="rel-links"><a href="${base}/manifest.json">manifest.json</a><a href="${base}/CHANGES.md">CHANGES.md</a><a href="${base}/SHA256SUMS">SHA256SUMS</a></p>
      </section>`;
}

/** The /releases/<dataset> page: every release of one dataset, newest first. */
export function renderReleaseDataset(index, dataset, layerIds = new Set()) {
  const list = byDataset(index).get(dataset) || [];
  const title = list[0]?.title || dataset;
  const facts = [
    pair('Newest', `<a href="/releases/${esc(dataset)}/latest">bharatlas.com/releases/${esc(dataset)}/latest</a> always leads to the newest release`),
    layerIds.has(dataset) ? pair('Layer', `<a href="/view/${esc(dataset)}">See it on the map</a>, always the latest data`) : '',
  ].filter(Boolean).join('\n          ');
  const main = `      <p class="crumbs"><a href="/releases">Releases</a> / ${esc(dataset)}</p>
      <h1 class="page-title">${esc(title)}</h1>
      <p class="page-lead">Every release of <code>${esc(dataset)}</code>, newest first: ${plural(list.length, 'release')}. A release never changes; a correction goes in the next month's release.</p>
      <ul class="pairs">
          ${facts}
      </ul>
${list.map(releaseSection).join('\n')}`;
  return page({
    title: `${title}: releases`,
    description: `Dated releases of ${title} from bharatlas, each with a SHA-256 pin and a permanent w3id.org address to cite.`,
    path: `/releases/${dataset}`,
  }, main);
}

/** Every page to emit: [{fileName, html}]. */
export function releasePages(index, layerIds = new Set()) {
  return [
    { fileName: 'releases.html', html: renderReleasesIndex(index, layerIds) },
    ...[...byDataset(index).keys()].map((ds) => ({ fileName: `releases/${ds}.html`, html: renderReleaseDataset(index, ds, layerIds) })),
  ];
}
