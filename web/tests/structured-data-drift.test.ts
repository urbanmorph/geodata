import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildViewDataset, type CatalogLayer } from '../functions/lib/view-dataset';
import { openapiFor } from '../functions/lib/openapi';

// The pages are built with the point lookups off (POINT_PROFILES unset), so they describe the published API.
const OPENAPI = openapiFor(process.env.POINT_PROFILES === 'on');
import { PUBLISHER_LD } from '../../shared/brand.mjs';

// Structured data that used to drift from the site: the publisher named three
// ways, a hardcoded endpoint count, a fixed format list, a credit line without
// the source's own name, and a dual licence collapsed to its first half.

const ORIGIN = 'https://bharatlas.com';
const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
function graph(file: string): any[] {
  const m = read(file).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`no JSON-LD in ${file}`);
  const data = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  return data['@graph'] || [data];
}

const base: CatalogLayer = { id: 'gb_adm1', level: 'gb_adm1', source: 'geoBoundaries', rows: 36, licence: 'CC-BY-4.0' };
const file = (name: string) => ({ url: `https://r2.example/${name}`, bytes: 10 });

describe('one publisher across the JSON-LD', () => {
  it('is bharatlas, part of Urban Morph', () => {
    expect(PUBLISHER_LD).toMatchObject({
      '@type': 'Organization', name: 'bharatlas', url: 'https://bharatlas.com',
      parentOrganization: { '@type': 'Organization', name: 'Urban Morph', url: 'https://urbanmorph.com' },
    });
  });

  it('home WebSite, /docs WebAPI, /about AboutPage and every /view Dataset use it', () => {
    expect(graph('index.html').find((n) => n['@type'] === 'WebSite').publisher).toEqual(PUBLISHER_LD);
    expect(graph('docs.html').find((n) => n['@type'] === 'WebAPI').provider).toEqual(PUBLISHER_LD);
    expect(graph('about.html').find((n) => n['@type'] === 'AboutPage').publisher).toEqual(PUBLISHER_LD);
    expect(buildViewDataset(base, undefined, ORIGIN).jsonLd.publisher).toEqual(PUBLISHER_LD);
  });

  it('the home WebSite describes the site as it is now, without "catalog"', () => {
    const site = graph('index.html').find((n) => n['@type'] === 'WebSite');
    expect(site.description).not.toMatch(/catalog/i);
    expect(site.description).toMatch(/layers/);
  });
});

describe('/docs WebAPI', () => {
  it('counts its endpoints from the OpenAPI paths', () => {
    const api = graph('docs.html').find((n) => n['@type'] === 'WebAPI');
    const n = Object.keys(OPENAPI.paths).length;
    expect(api.description).toContain(`${n} endpoints`);
  });

  it('has a reference entry for every OpenAPI path', () => {
    const html = read('docs.html');
    for (const path of Object.keys(OPENAPI.paths)) {
      expect(html, path).toContain(`<span class="endpoint">/api/v1${path.replace(/\{(\w+)\}/g, ':$1')}</span>`);
    }
  });

  it('documents every query parameter of query, export, counts and one-layer locate', () => {
    const html = read('docs.html');
    for (const name of ['order_by', 'filter', 'format', 'estimate', 'mode', 'filter_col', 'filter_val', 'unknown_layers']) {
      expect(html, name).toContain(`<code>${name}</code>`);
    }
    expect(html).not.toMatch(/badge--soon">coming<\/span>\s*Crosswalks/);
  });
});

describe('/view Dataset JSON-LD', () => {
  it('names only the formats the layer has in its fallback description', () => {
    const ld = buildViewDataset({ ...base, parquet: file('a.parquet'), pmtiles: file('a.pmtiles'), geojson: file('a.geojson') }, undefined, ORIGIN).jsonLd;
    expect(ld.description).toContain('Parquet, PMTiles or GeoJSON');
    expect(ld.description).not.toContain('KML');
  });

  it('credits the source by its own name and its republisher', () => {
    const ld = buildViewDataset({
      ...base, id: 'lgd_states', source: 'LGD',
      attribution: {
        primary: { name: 'Local Government Directory', url: 'https://lgdirectory.gov.in/' },
        publisher: { name: 'yashveeeeeeer/india-geodata', url: 'https://github.com/yashveeeeeeer/india-geodata' },
      },
    }, undefined, ORIGIN).jsonLd;
    expect(ld.creditText).toBe('Source: Local Government Directory, via yashveeeeeeer/india-geodata. Published via bharatlas (bharatlas.com). Licence: CC-BY-4.0.');
    expect(ld.creator).toEqual({ '@type': 'Organization', name: 'Local Government Directory', url: 'https://lgdirectory.gov.in/' });
  });

  it('does not name bharatlas twice when bharatlas is the republisher, and falls back to source', () => {
    const own = buildViewDataset({
      ...base, attribution: { primary: { name: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' }, publisher: { name: 'bharatlas', url: ORIGIN } },
    }, undefined, ORIGIN).jsonLd;
    expect(own.creditText).toBe('Source: © OpenStreetMap contributors. Published via bharatlas (bharatlas.com). Licence: CC-BY-4.0.');
    expect(buildViewDataset(base, undefined, ORIGIN).jsonLd.creditText).toBe('Source: geoBoundaries. Published via bharatlas (bharatlas.com). Licence: CC-BY-4.0.');
  });

  it('emits both licence URLs for a dual licence', () => {
    const ld = buildViewDataset({ ...base, licence: 'CC0-1.0 / CC-BY-4.0' }, undefined, ORIGIN).jsonLd;
    expect(ld.license).toEqual(['https://creativecommons.org/publicdomain/zero/1.0/', 'https://creativecommons.org/licenses/by/4.0/']);
    expect(buildViewDataset(base, undefined, ORIGIN).jsonLd.license).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('carries dateModified from fetched_at and the newest release as version', () => {
    const ld = buildViewDataset({
      ...base, fetched_at: '2026-10-07T12:00:00Z',
      versions: [
        { code: 'bharatlas-gb_adm1-2026.12', released: '2026-12-01', sha256: 'b', w3id: 'https://w3id.org/bharatlas/gb_adm1/2026.12', url: 'u' },
        { code: 'bharatlas-gb_adm1-2026.11', released: '2026-11-01', sha256: 'a', w3id: 'https://w3id.org/bharatlas/gb_adm1/2026.11', url: 'u' },
      ],
    }, undefined, ORIGIN).jsonLd;
    expect(ld.dateModified).toBe('2026-10-07');
    expect(ld.version).toBe('bharatlas-gb_adm1-2026.12');
    const bare = buildViewDataset(base, undefined, ORIGIN).jsonLd;
    expect(bare).not.toHaveProperty('dateModified');
    expect(bare).not.toHaveProperty('version');
  });
});
