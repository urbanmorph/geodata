// Server-side filtering for layers too large to filter in the browser
// (LARGE_FILTER_BYTES): the Filter panel's filters travel as `filter=` JSON to
// /api/v1/layers/{id}/query (count) and /export (streamed rows).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { query, QueryInputError } from '../functions/lib/parquet-query';
import { parseFilterParam, exportRows, EXPORT_MAX_ROWS } from '../functions/lib/parquet-export';
import { parseQueryParams } from '../functions/lib/query-params';

// 30 polygons: state KA/MH/TN (10 each), class Pediplain (even i) / Valley Fill,
// area = i * 1.5, flag = (i % 5 == 0), and a GEOM_UNIT text column (a source
// column whose name contains "geom", as in groundwater prospects) before the
// geometry.
const buf = readFileSync(new URL('./fixtures/filter-export.parquet', import.meta.url));
const file = {
  byteLength: buf.byteLength,
  slice: async (start: number, end?: number) =>
    buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + (end ?? buf.byteLength)) as ArrayBuffer,
};

async function collect(it: AsyncIterable<string>): Promise<string> {
  let s = '';
  for await (const chunk of it) s += chunk;
  return s;
}

describe('parseFilterParam', () => {
  it('reads the panel filters (in, range, search, bool)', () => {
    const f = parseFilterParam(JSON.stringify([
      { col: 'state', kind: 'in', values: ['KA', 'TN'] },
      { col: 'area', kind: 'range', min: 3, max: 9 },
      { col: 'class', kind: 'search', q: 'fill' },
      { col: 'flag', kind: 'bool', v: true },
    ]));
    expect(f).toHaveLength(4);
  });
  it('is undefined when absent', () => {
    expect(parseFilterParam(null)).toBeUndefined();
  });
  it('rejects what is not a filter list, with a 400-class error', () => {
    for (const bad of ['nope', '{}', '[{"col":"a","kind":"like"}]', '[{"kind":"in","values":[]}]',
      JSON.stringify(Array.from({ length: 21 }, () => ({ col: 'a', kind: 'bool', v: true })))]) {
      expect(() => parseFilterParam(bad), bad).toThrow(QueryInputError);
    }
  });
  it('is a query option, never a column filter', () => {
    const p = parseQueryParams(new URLSearchParams('filter=[]&state=KA'));
    expect(p.where).toEqual({ state: 'KA' });
  });
});

describe('query with filters', () => {
  it('counts matches across row groups: in (two values) and a range', async () => {
    const r = await query(file, {
      filters: [{ col: 'state', kind: 'in', values: ['ka', 'TN'] }, { col: 'area', kind: 'range', min: 0, max: 15 }],
      limit: 1,
    }) as { total: number };
    // i 0..10 (area <= 15) in KA or TN: KA i=0,3,6,9; TN i=2,5,8 -> 7
    expect(r.total).toBe(7);
  });
  it('search is a case-insensitive substring; bool matches exactly', async () => {
    const s = await query(file, { filters: [{ col: 'class', kind: 'search', q: 'FILL' }], limit: 1 }) as { total: number };
    expect(s.total).toBe(15);
    const b = await query(file, { filters: [{ col: 'flag', kind: 'bool', v: true }], limit: 1 }) as { total: number };
    expect(b.total).toBe(6);
  });
  it('combines with where and group_by', async () => {
    const g = await query(file, {
      where: { class: 'Pediplain' },
      filters: [{ col: 'state', kind: 'in', values: ['KA'] }],
      groupBy: 'state',
    }) as { counts: Record<string, number>; total: number };
    expect(g.counts).toEqual({ KA: 5 });
  });
  it('rejects a filter on an unknown or geometry column', async () => {
    await expect(query(file, { filters: [{ col: 'nope', kind: 'bool', v: true }] })).rejects.toThrow(QueryInputError);
    await expect(query(file, { filters: [{ col: 'geometry', kind: 'search', q: 'x' }] })).rejects.toThrow(QueryInputError);
  });
});

describe('exportRows', () => {
  const ka = [{ col: 'state', kind: 'in' as const, values: ['KA'] }];

  it('streams GeoJSON with geometry and every column but the bbox', async () => {
    const out = await exportRows(file, { filters: ka, format: 'geojson' });
    expect(out.total).toBe(10);
    const fc = JSON.parse(await collect(out.chunks));
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(10);
    const f = fc.features[0];
    expect(f.geometry.type).toBe('Polygon');
    expect(f.geometry.coordinates[0][0][0]).toBeGreaterThan(76); // lon first
    expect(Object.keys(f.properties).sort()).toEqual(['GEOM_UNIT', 'area', 'class', 'flag', 'id', 'state']);
    expect(f.properties.GEOM_UNIT).toMatch(/^unit /);
  });

  it('streams KML placemarks and CSV rows with a centroid', async () => {
    const kml = await collect((await exportRows(file, { filters: ka, format: 'kml', name: 'lyr' })).chunks);
    expect(kml.match(/<Placemark>/g)).toHaveLength(10);
    expect(kml).toContain('<coordinates>');
    const csv = await collect((await exportRows(file, { filters: ka, format: 'csv' })).chunks);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('id,state,GEOM_UNIT,class,area,flag,_lat,_lng');
    expect(lines).toHaveLength(11);
  });

  it('refuses more rows than the cap, before reading any geometry, with guidance', async () => {
    await expect(exportRows(file, { filters: [{ col: 'flag', kind: 'bool', v: false }], format: 'geojson', maxRows: 5 }))
      .rejects.toThrow(/24 rows match.*5/);
    expect(EXPORT_MAX_ROWS).toBe(50_000);
  });

  it('needs a filter: the whole layer is a download, not an export', async () => {
    await expect(exportRows(file, { format: 'geojson' })).rejects.toThrow(QueryInputError);
  });
});

describe('the geometry column is named geometry (or geom, wkb_geometry), not anything containing "geom"', () => {
  it('a source column like GEOM_UNIT is an ordinary column: returned, filtered, grouped', async () => {
    const { isGeomColumn } = await import('../functions/lib/parquet-query');
    expect(['geometry', 'GEOMETRY', 'geom', 'wkb_geometry', 'the_geom'].every(isGeomColumn)).toBe(true);
    expect(['GEOM_UNIT', 'geom_landf', 'Geom_Code_1', 'geomorphology'].some(isGeomColumn)).toBe(false);
    const r = await query(file, { where: { GEOM_UNIT: 'unit 3' }, limit: 5 }) as { total: number; columns: string[] };
    expect(r.total).toBe(1);
    expect(r.columns).toContain('GEOM_UNIT');
    const g = await query(file, { filters: [{ col: 'GEOM_UNIT', kind: 'search', q: 'unit 1' }], groupBy: 'state' }) as { total: number };
    expect(g.total).toBe(11); // unit 1, 10..19
  });
});
