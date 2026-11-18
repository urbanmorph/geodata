// Value layers (money or measured quantities per polygon) are coloured by one
// column: catalog layer.choropleth = { column, label, unit, breaks }. The
// breaks are precomputed from the parquet (scripts/choropleth_breaks.py)
// so the browser never scans data; this pins the pure pieces.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHOROPLETH_RAMP, NO_DATA_HATCH, rampFor, fmtLegendNumber,
  fillColorExpr, noDataFilter, legendHtml, combineFilters, hatchPixels,
} from '../../shared/choropleth.mjs';

const spec = { column: 'Total_Exp', label: 'Total spending, 2025-26', unit: 'Rs lakh', breaks: [3000, 6600, 11000, 21000] };

describe('rampFor', () => {
  it('uses the whole ramp for five classes and spreads fewer across it', () => {
    expect(rampFor(5)).toEqual(CHOROPLETH_RAMP);
    expect(rampFor(3)).toEqual([CHOROPLETH_RAMP[0], CHOROPLETH_RAMP[2], CHOROPLETH_RAMP[4]]);
    expect(rampFor(1)).toEqual([CHOROPLETH_RAMP[2]]);
  });
  it('is one hue, light to dark', () => {
    const lum = (h: string) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
    for (let i = 1; i < CHOROPLETH_RAMP.length; i++) expect(lum(CHOROPLETH_RAMP[i])).toBeLessThan(lum(CHOROPLETH_RAMP[i - 1]));
  });
});

describe('fmtLegendNumber', () => {
  it('writes Indian numbers: grouping, then lakh and crore in words', () => {
    expect(fmtLegendNumber(6600)).toBe('6,600');
    expect(fmtLegendNumber(1.9)).toBe('1.9');
    expect(fmtLegendNumber(140000)).toBe('1.4 lakh');
    expect(fmtLegendNumber(65000000)).toBe('6.5 crore');
    expect(fmtLegendNumber(110000000000)).toBe('11,000 crore');
  });
});

describe('fillColorExpr', () => {
  it('steps the column through the ramp and leaves features without a number transparent', () => {
    const has = ['==', ['typeof', ['get', 'Total_Exp']], 'number'];
    expect(fillColorExpr(spec)).toEqual([
      'case', has,
      ['step', ['get', 'Total_Exp'], CHOROPLETH_RAMP[0], 3000, CHOROPLETH_RAMP[1], 6600, CHOROPLETH_RAMP[2],
        11000, CHOROPLETH_RAMP[3], 21000, CHOROPLETH_RAMP[4]],
      'rgba(0,0,0,0)',
    ]);
    expect(noDataFilter(spec)).toEqual(['!', has]);
  });
});

describe('hatchPixels', () => {
  it('is a tileable RGBA square with one navy diagonal per tile', () => {
    const img = hatchPixels(8);
    expect(img.width).toBe(8);
    expect(img.height).toBe(8);
    expect(img.data.length).toBe(8 * 8 * 4);
    const inked = (x: number, y: number) => img.data[(y * 8 + x) * 4 + 3] > 0;
    for (let y = 0; y < 8; y++) {
      const row = Array.from({ length: 8 }, (_, x) => inked(x, y));
      expect(row.filter(Boolean).length).toBe(1);
      expect(inked((7 - y), y)).toBe(true); // runs bottom-left to top-right
    }
    const i = (7 * 8 + 0) * 4;
    expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([0x0b, 0x1b, 0x3f]);
  });
});

describe('combineFilters', () => {
  it('ands a layer base filter with the user filter, keeping whichever exists', () => {
    const base = ['==', ['geometry-type'], 'Point'];
    const user = ['==', ['get', 'state'], 'Goa'];
    expect(combineFilters(base, user)).toEqual(['all', base, user]);
    expect(combineFilters(base, null)).toBe(base);
    expect(combineFilters(undefined, user)).toBe(user);
    expect(combineFilters(undefined, null)).toBeNull();
  });
});

describe('legendHtml', () => {
  const html = legendHtml(spec, 'districts');
  it('names the column and unit', () => {
    expect(html).toContain('Total spending, 2025-26');
    expect(html).toContain('Rs lakh');
  });
  it('states every class range in words, lowest first, then no data', () => {
    const rows = [...html.matchAll(/<li[^>]*>.*?<\/i>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(rows).toEqual(['under 3,000', '3,000 to 6,600', '6,600 to 11,000', '11,000 to 21,000', '21,000 and over', 'No data']);
  });
  it('says how the classes were made', () => {
    expect(html).toContain('about a fifth of the districts');
  });
  it('escapes catalog text', () => {
    expect(legendHtml({ ...spec, label: '<b>x</b>' }, 'districts')).not.toContain('<b>x</b>');
  });
  it('draws no data as a hatch', () => {
    expect(NO_DATA_HATCH).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(html).toContain('map-legend__sw--none');
  });
});

// The catalog carries each value layer's choropleth, with breaks computed by
// scripts/choropleth_breaks.py. A layer rebake that rewrites its catalog entry
// drops the block; this catches that (re-run the script).
const VALUE_LAYERS = ['mgnrega_districts', 'cityfinance_ulbs', 'state_finance', 'mi6_wells_districts', 'corestack_lulc_blocks', 'property_tax_chennai_wards', 'cityfinance_ulb_balance_sheets'];
describe('catalog choropleths', () => {
  const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8')) as {
    layers: { id: string; choropleth?: { column: string; label: string; unit: string; breaks: number[] } }[];
  };
  const byId = new Map(catalog.layers.map((l) => [l.id, l]));
  for (const id of VALUE_LAYERS) {
    it(`${id} declares a column, label, unit and ascending breaks`, () => {
      const c = byId.get(id)?.choropleth;
      expect(c).toBeDefined();
      for (const k of ['column', 'label', 'unit'] as const) expect(c![k]).toMatch(/\S/);
      expect(c!.breaks.length).toBeGreaterThan(1);
      expect(c!.breaks.length).toBeLessThan(CHOROPLETH_RAMP.length);
      for (let i = 1; i < c!.breaks.length; i++) expect(c!.breaks[i]).toBeGreaterThan(c!.breaks[i - 1]);
    });
  }
  it('no other layer has one', () => {
    for (const l of catalog.layers) if (l.choropleth) expect(VALUE_LAYERS).toContain(l.id);
  });
});
