import { describe, it, expect } from 'vitest';
import {
  buildWardTable,
  buildViewContent,
  buildViewDataset,
  type WardIndex,
  type CatalogLayer,
  type LevelMeta,
} from '../functions/lib/view-dataset';

// The ward#→area table is the answer payload for the loudest 0-click GSC
// cluster ("ward 22 ahmedabad area name", "vmc ward list area wise vadodara").
// A map page can't satisfy that in the SERP; a crawlable table can. The table
// must render ONLY the columns the layer actually carries — never invent an
// area name for a number-only layer (Kolkata/Mumbai). Data is what it is.

const AHMEDABAD: WardIndex = {
  id: 'wards_ahmedabad',
  place: 'Ahmedabad',
  updated: '2026-05-26',
  nameLabel: 'Area',
  rows: [
    { no: '1', name: 'Gota' },
    { no: '22', name: 'India colony' },
    { no: '26', name: 'Bapu Nagar' },
  ],
};

const KOLKATA: WardIndex = {
  id: 'wards_kolkata',
  place: 'Kolkata',
  nameLabel: null, // number-only source — no area names exist
  rows: [{ no: '12', name: '' }, { no: '141', name: '' }],
};

describe('buildWardTable', () => {
  it('renders a number↔area table when the layer carries names', () => {
    const { html, jsonLd } = buildWardTable(AHMEDABAD);
    expect(html).toContain('<table');
    expect(html).toContain('India colony');
    expect(html).toContain('>22<'); // the ward number is a cell
    expect(html).toContain('Area'); // the name-column header
    expect(html.toLowerCase()).toContain('ahmedabad');
    // ItemList carries the answer for "ward 22 ahmedabad area name"
    expect(jsonLd).not.toBeNull();
    expect(jsonLd!['@type']).toBe('ItemList');
    expect(JSON.stringify(jsonLd)).toContain('Ward 22: India colony');
  });

  it('NEVER invents names for a number-only layer', () => {
    const { html, jsonLd } = buildWardTable(KOLKATA);
    expect(html).toContain('141'); // numbers still listed (presence for "ward 141 kolkata")
    expect(html).not.toContain('Area');
    expect(html).not.toMatch(/undefined|null/);
    expect(jsonLd).toBeNull(); // no answer payload to assert without names
  });

  it('escapes HTML in area names', () => {
    const { html } = buildWardTable({
      ...AHMEDABAD,
      rows: [{ no: '9', name: 'Tom & Jerry <ward>' }],
    });
    expect(html).toContain('Tom &amp; Jerry &lt;ward&gt;');
    expect(html).not.toContain('<ward>');
  });

  it('returns empty for missing / empty data (no crash)', () => {
    for (const v of [null, undefined, { ...AHMEDABAD, rows: [] }]) {
      const { html, jsonLd } = buildWardTable(v as WardIndex | null);
      expect(html).toBe('');
      expect(jsonLd).toBeNull();
    }
  });
});

const WARD_LAYER: CatalogLayer = { id: 'wards_ahmedabad', level: 'wards_ahmedabad', source: 'AMC', rows: 48 };
const WARD_META: LevelMeta = {
  label: 'Ahmedabad (AMC) Wards',
  unit: 'wards',
  seo_title: 'Ahmedabad Ward Map: 48 wards (AMC)',
  seo_description: 'View ward boundaries and names, filter by ward.',
};
const NON_WARD: CatalogLayer = { id: 'lgd_districts', level: 'district', source: 'LGD', rows: 766 };

describe('buildViewContent ward wiring', () => {
  it('injects the answer table + city cross-links on a named ward page', () => {
    const html = buildViewContent(WARD_LAYER, WARD_META, 'https://bharatlas.com', AHMEDABAD);
    expect(html).toContain('class="ward-index"');
    expect(html).toContain('India colony');
    // cross-links to OTHER cities, never to itself
    expect(html).toContain('/view/wards_kolkata');
    expect(html).toContain('Ward maps for other cities');
    expect(html).not.toContain('>Ahmedabad ward map<'); // current city omitted from the nav
  });

  it('still cross-links but omits the table when a ward has no index', () => {
    const html = buildViewContent(WARD_LAYER, WARD_META, 'https://bharatlas.com', null);
    expect(html).not.toContain('class="ward-index"');
    expect(html).toContain('/view/wards_kolkata'); // cross-links independent of data
  });

  it('leaves non-ward layers completely unchanged (no table, no ward nav)', () => {
    const html = buildViewContent(NON_WARD, { label: 'Districts', unit: 'districts' }, 'https://bharatlas.com', null);
    expect(html).not.toContain('ward-index');
    expect(html).not.toContain('Ward maps for other cities');
  });

  it('emits ItemList JSON-LD on the dataset only when the ward has names', () => {
    const withNames = buildViewDataset(WARD_LAYER, WARD_META, 'https://bharatlas.com', AHMEDABAD);
    expect(withNames.wardListJsonLd).toBeTruthy();
    expect(JSON.stringify(withNames.wardListJsonLd)).toContain('India colony');
    const without = buildViewDataset(WARD_LAYER, WARD_META, 'https://bharatlas.com', null);
    expect(without.wardListJsonLd).toBeUndefined();
  });
});

// A number-only layer (Jaipur) whose wards have OpenStreetMap area names in its sidecar. The view shows them in
// their own column, credited to OSM (ODbL); the layer's own fields (and its downloads) stay as the source published.
const JAIPUR_OSM: WardIndex = {
  id: 'wards_jaipur',
  place: 'Jaipur',
  updated: '2026-05-26',
  nameLabel: null,
  rows: [
    { no: '1', name: '', areas: ['Raja Park', 'Adarsh Nagar'] },
    { no: '2', name: '', areas: [] },
  ],
  areasSource: { name: 'OpenStreetMap contributors', licence: 'ODbL-1.0', fetched: '2026-11-12' },
};

describe('buildWardTable with OpenStreetMap areas', () => {
  it('adds an "Areas (OpenStreetMap)" column and credits OSM, apart from the layer\'s own names', () => {
    const { html, jsonLd } = buildWardTable(JAIPUR_OSM);
    expect(html).toContain('<th scope="col">Areas (OpenStreetMap)</th>');
    expect(html).toContain('<td>Raja Park, Adarsh Nagar</td>');
    expect(html).toContain('Jaipur ward numbers and the areas in each');
    expect(html).toMatch(/OpenStreetMap contributors.*ODbL/);
    expect(html).toMatch(/not part of the ward layer or its downloads/);
    expect(html).not.toContain('<th scope="col">Area</th>');   // no column for names the layer doesn't have
    expect(JSON.stringify(jsonLd)).toContain('Ward 1: Raja Park, Adarsh Nagar (OpenStreetMap)');
    expect(JSON.stringify(jsonLd)).not.toContain('Ward 2:');   // a ward with no area is not listed with an empty name
  });

  it('a layer with its own names and OSM areas shows both columns', () => {
    const both: WardIndex = { ...AHMEDABAD, rows: [{ no: '1', name: 'Gota', areas: ['Vande Mataram'] }],
      areasSource: JAIPUR_OSM.areasSource };
    const { html } = buildWardTable(both);
    expect(html).toContain('<th scope="col">Area</th><th scope="col">Areas (OpenStreetMap)</th>');
    expect(html).toContain('<td>1</td><td>Gota</td><td>Vande Mataram</td>');
  });
});
