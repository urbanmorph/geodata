// Build-time prerender: produce one large card per admin level.
// Zero JS needed to read or navigate the catalog.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const ROOT = resolve(WEB, '..');

const catalogPath = resolve(ROOT, 'catalog.json');
if (!existsSync(catalogPath)) {
  console.error('catalog.json not found at', catalogPath, '— run scripts/build_catalog.py first');
  process.exit(1);
}
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
await copyFile(catalogPath, resolve(WEB, 'public', 'catalog.json'));

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
const fmtRows = (n) => (n == null ? '—' : n.toLocaleString('en-IN'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Per-level descriptions and unit labels — plain English, not table-speak.
const LEVEL_META = {
  state: {
    label: 'States',
    unit: 'states & UTs',
    description: 'Pan-India state and Union Territory boundaries. The base layer for every drill-down.',
  },
  district: {
    label: 'Districts',
    unit: 'districts',
    description: 'Every district in India. Joins to states via the LGD code.',
  },
  subdistrict: {
    label: 'Sub-districts',
    unit: 'sub-districts',
    description: 'Tehsils, talukas and sub-divisions — the layer below a district.',
  },
  block: {
    label: 'Blocks',
    unit: 'community-development blocks',
    description: 'Community-development blocks. The administrative unit that groups villages.',
  },
  village: {
    label: 'Villages',
    unit: 'villages',
    description: 'Every revenue village in India. The finest admin polygon — 584k of them.',
  },
};
const LEVEL_ORDER = ['state', 'district', 'subdistrict', 'block', 'village'];

// Pick the primary layer for each level. LGD is canonical wherever it exists.
function pickPrimary(layers) {
  return layers.find((l) => l.source === 'LGD') || layers[0];
}

function downloadLinks(layer) {
  const items = [];
  if (layer.parquet?.url) items.push({ fmt: 'parquet', url: layer.parquet.url, size: layer.parquet.bytes });
  if (layer.pmtiles?.url) items.push({ fmt: 'pmtiles', url: layer.pmtiles.url, size: layer.pmtiles.bytes });
  if (layer.geojson?.url) items.push({ fmt: 'geojson', url: layer.geojson.url, size: layer.geojson.bytes });
  return items;
}

function renderRow(level, layersForLevel) {
  const meta = LEVEL_META[level];
  if (!meta) return '';
  const primary = pickPrimary(layersForLevel);
  const others = layersForLevel.filter((l) => l !== primary);

  const viewable = !!(primary.pmtiles?.url || primary.geojson?.url);
  const viewBtn = viewable
    ? `<a href="#view/${esc(primary.id)}" class="btn-primary">View map →</a>`
    : `<span class="btn-primary disabled" title="No map for this layer">no map</span>`;

  const downloads = downloadLinks(primary);
  const dlInline = downloads.length
    ? `<span class="dl-inline">${downloads
        .map(
          (d, i) =>
            `${i > 0 ? '<span class="dot">·</span>' : ''}<a href="${esc(d.url)}" download>${esc(d.fmt)}</a><span class="size">${fmtBytes(d.size)}</span>`
        )
        .join('')}</span>`
    : '';

  const altSection = others.length
    ? `<details class="alt">
        <summary>alt sources: ${others.map((o) => esc(o.source)).join(' · ')}</summary>
        <div class="alt__list">
          ${others
            .map((o) => {
              const dl = downloadLinks(o);
              const viewable = !!(o.pmtiles?.url || o.geojson?.url);
              const links = [
                viewable ? `<a href="#view/${esc(o.id)}">view</a>` : '',
                ...dl.map((d) => `<a href="${esc(d.url)}" download>${esc(d.fmt)}</a>`),
              ]
                .filter(Boolean)
                .join('<span class="dot">·</span>');
              return `<div class="alt__row">
                <span class="src">${esc(o.source)}</span>
                <span class="meta">${fmtRows(o.rows)} rows · ${esc(o.notes || '')}</span>
                <span class="links">${links}</span>
              </div>`;
            })
            .join('')}
        </div>
      </details>`
    : '';

  const lic = primary.licence ? `<span class="lic"><code>${esc(primary.licence)}</code></span>` : '';

  return `<section class="row" id="${esc(level)}">
      <div class="row__head">
        <span class="row__title">${esc(meta.label)}</span>
        <span class="row__meta">${fmtRows(primary.rows)} ${esc(meta.unit)}<span class="dot">·</span>${lic}</span>
      </div>
      <p class="row__desc">${esc(meta.description)}</p>
      <div class="row__actions">
        ${viewBtn}
        ${dlInline}
      </div>
      ${altSection}
    </section>`;
}

// Group layers by level
const byLevel = {};
for (const l of catalog.layers) {
  (byLevel[l.level] ||= []).push(l);
}
const cards = LEVEL_ORDER.filter((lvl) => byLevel[lvl]?.length)
  .map((lvl) => renderRow(lvl, byLevel[lvl]))
  .join('\n');

// Attribution footer
const attrLinks = Object.entries(catalog.attribution || {})
  .filter(([k]) => !k.startsWith('_'))
  .map(([, val]) => `<a href="${esc(val.url)}" target="_blank" rel="noopener">${esc(val.name)}</a>`)
  .join(' · ');
const publisher = catalog.attribution?._publisher;
const publisherLink = publisher
  ? `<a href="${esc(publisher.url)}" target="_blank" rel="noopener">${esc(publisher.name)}</a>`
  : '';

// Inline the full catalog so map + filter open with zero network roundtrips.
// Catalog is small (~20 KB raw, ~5 KB additional gz) — worth it.
const inlineCatalog = JSON.stringify(catalog);

const tmpl = await readFile(resolve(WEB, 'index.template.html'), 'utf8');
const out = tmpl
  .replace('<!-- LEVEL_CARDS -->', cards)
  .replace('<!-- GENERATED -->', esc(catalog.generated || ''))
  .replace('<!-- ATTR_LINKS -->', attrLinks)
  .replace('<!-- PUBLISHER -->', publisherLink)
  .replace('<!-- CATALOG_INLINE -->', `<script type="application/json" id="catalog-data">${inlineCatalog.replace(/</g, '\\u003c')}</script>`);

await writeFile(resolve(WEB, 'index.html'), out);
console.log(`prerendered ${LEVEL_ORDER.filter((l) => byLevel[l]?.length).length} level cards (+ inline catalog ${inlineCatalog.length} B)`);
