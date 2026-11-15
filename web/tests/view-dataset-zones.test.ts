import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildZoneList,
  buildViewContent,
  buildViewDataset,
  wardSeo,
  type WardIndex,
  type CatalogLayer,
} from '../functions/lib/view-dataset';

// "zone wise ward list lucknow", "bhopal nagar nigam zone list", "gvmc zone wise wards": a ward page whose layer
// carries a zone column answers with the wards grouped under their zones. Zones come only from the layer's own
// column (scripts/build_ward_index.py); a layer without one gets nothing new.

const LUCKNOW: WardIndex = {
  id: 'wards_lucknow',
  place: 'Lucknow',
  nameLabel: 'Area',
  rows: [
    { no: '0', name: 'Airport' },
    { no: '1', name: 'Ibrahimpur', zone: '1' },
    { no: '2', name: 'Raja Bijli Pasi', zone: '10' },
    { no: '3', name: 'Tilak <Nagar>', zone: '2' },
    { no: '4', name: 'Kharika', zone: '1' },
  ],
};

const VIZAG: WardIndex = {
  id: 'wards_vizag',
  place: 'Visakhapatnam',
  nameLabel: 'Zone',
  rows: [
    { no: '1', name: 'Zone-1', zone: 'Zone-1' },
    { no: '2', name: 'Zone-2', zone: 'Zone-2' },
  ],
};

describe('buildZoneList', () => {
  it('groups wards under their zones, in zone order, with a count for each', () => {
    const { html, zones } = buildZoneList(LUCKNOW);
    expect(zones).toBe(3);
    expect(html).toContain('Lucknow zone-wise ward list');
    const z1 = html.indexOf('Zone 1 (2 wards)');
    const z2 = html.indexOf('Zone 2 (1 ward)');
    const z10 = html.indexOf('Zone 10 (1 ward)');
    expect(z1).toBeGreaterThan(-1);
    expect(z1).toBeLessThan(z2); // zones sort as numbers: 2 before 10
    expect(z2).toBeLessThan(z10);
    expect(html).toContain('Ward 1 Ibrahimpur');
    expect(html).toContain('Ward 4 Kharika');
  });

  it('says how many wards the source gives no zone, and lists them under no zone', () => {
    const { html } = buildZoneList(LUCKNOW);
    expect(html).toContain('4 wards in 3 zones');
    expect(html).toContain('1 ward has no zone in the source');
    expect(html).not.toMatch(/Zone undefined|Zone null|Zone \(/);
  });

  it('keeps a zone that names itself as it is, and does not repeat it as the ward name', () => {
    const { html } = buildZoneList(VIZAG);
    expect(html).toContain('Zone-1 (1 ward)');
    expect(html).not.toContain('Zone Zone-1');
    expect(html).toContain('Ward 1<');
    expect(html).not.toContain('Ward 1 Zone-1');
  });

  it('escapes HTML in names and zones', () => {
    const { html } = buildZoneList(LUCKNOW);
    expect(html).toContain('Tilak &lt;Nagar&gt;');
    expect(html).not.toContain('<Nagar>');
  });

  it('renders nothing without zones, or with only one zone', () => {
    expect(buildZoneList({ ...LUCKNOW, rows: [{ no: '1', name: 'A' }] }).html).toBe('');
    expect(buildZoneList({ ...LUCKNOW, rows: [{ no: '1', name: 'A', zone: '1' }, { no: '2', name: 'B', zone: '1' }] }).html).toBe('');
    expect(buildZoneList(null).zones).toBe(0);
  });
});

const LAYER: CatalogLayer = { id: 'wards_lucknow', name: 'Lucknow wards', source: 'LMC', rows: 112 } as CatalogLayer;
const META = { seo_title: 'Lucknow Ward Map: zone-wise list of 112 wards (LMC)', seo_description: 'View ward boundaries and names.' };

describe('ward page with zones', () => {
  it('shows the zone-wise list in the page', () => {
    expect(buildViewContent(LAYER, META, 'https://bharatlas.com', LUCKNOW)).toContain('Lucknow zone-wise ward list');
  });

  it('says zone-wise in the meta description, within the SERP cap', () => {
    const { description } = buildViewDataset(LAYER, META, 'https://bharatlas.com', LUCKNOW);
    expect(description).toContain('zone-wise ward list');
    expect(description).toContain('3 zones');
    expect(description.length).toBeLessThanOrEqual(158);
  });

  it('leaves a ward page without zones as it was', () => {
    const plain = { ...LUCKNOW, rows: [{ no: '1', name: 'A' }] };
    const { description } = buildViewDataset(LAYER, META, 'https://bharatlas.com', plain);
    expect(description).toBe(wardSeo(META.seo_title, '112', META.seo_description).description);
    expect(buildViewContent(LAYER, META, 'https://bharatlas.com', plain)).not.toContain('ward-zones');
  });
});

// The real sidecars and catalog: every layer whose sidecar has zones says so in its title, and no other does.
describe('zone layers in the real catalog', () => {
  const root = join(__dirname, '..', '..');
  const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));
  const wardIds: string[] = catalog.layers.map((l: { id: string }) => l.id).filter((id: string) => id.startsWith('wards_'));
  const zoned = (id: string) => {
    try {
      return buildZoneList(JSON.parse(readFileSync(join(root, 'web', 'public', 'ward-index', `${id}.json`), 'utf8'))).zones > 0;
    } catch {
      return false;
    }
  };

  it('titles mention zones exactly where the sidecar has them', () => {
    for (const id of wardIds) {
      const title: string = catalog.level_meta[id]?.seo_title ?? '';
      expect([id, /zone/i.test(title)]).toEqual([id, zoned(id)]);
    }
  });

  it('the cities in the search queries that carry zones are covered', () => {
    for (const id of ['wards_lucknow', 'wards_bhopal', 'wards_vizag', 'wards_pcmc']) expect([id, zoned(id)]).toEqual([id, true]);
    for (const id of ['wards_indore', 'wards_surat', 'wards_vadodara']) expect([id, zoned(id)]).toEqual([id, false]);
  });
});
