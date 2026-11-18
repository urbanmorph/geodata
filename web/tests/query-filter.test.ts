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

describe('export size cap', () => {
  const ka = [{ col: 'state', kind: 'in' as const, values: ['KA'] }];

  // Footer-only metadata shaped like groundwater prospects: Karnataka's 41,448
  // rows (218 MB uncompressed over the exported columns; its GeoJSON measured
  // 609 MB) and Sikkim with a class (179 rows, 0.99 MB; GeoJSON 6.5 MB).
  const meta = (groups: Array<[rows: number, bytes: number]>) => ({
    row_groups: groups.map(([rows, bytes]) => ({
      num_rows: rows,
      columns: [{ meta_data: { path_in_schema: ['geometry'], total_uncompressed_size: bytes } }],
    })),
  }) as never;

  it('refuses a Karnataka-size GeoJSON and allows a Sikkim-size one', async () => {
    const { estimateExportBytes, EXPORT_MAX_BYTES } = await import('../functions/lib/parquet-export');
    const kaEst = estimateExportBytes(meta([[41_448, 218_000_000]]), [{ count: 41_448 }], ['geometry'], 'geojson');
    const skEst = estimateExportBytes(meta([[179, 992_000]]), [{ count: 179 }], ['geometry'], 'geojson');
    expect(EXPORT_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(kaEst).toBeGreaterThan(EXPORT_MAX_BYTES);
    expect(kaEst).toBeGreaterThanOrEqual(609_000_000); // never below the measured size
    expect(skEst).toBeLessThan(EXPORT_MAX_BYTES);
    expect(skEst).toBeGreaterThanOrEqual(6_500_000);
  });

  it('weights each row group by its own matches and only the exported columns', async () => {
    const { estimateExportBytes } = await import('../functions/lib/parquet-export');
    const m = meta([[100, 1000], [100, 100_000]]);
    const dense = estimateExportBytes(m, [{ count: 0 }, { count: 10 }], ['geometry'], 'geojson');
    const sparse = estimateExportBytes(m, [{ count: 10 }, { count: 0 }], ['geometry'], 'geojson');
    expect(dense).toBeGreaterThan(sparse * 50);
    expect(estimateExportBytes(m, [{ count: 10 }, { count: 10 }], ['other'], 'geojson')).toBe(0);
  });

  it('exportRows refuses above the byte cap with the estimate, the count and where to go instead', async () => {
    await expect(exportRows(file, { filters: ka, format: 'geojson', maxBytes: 100, tooManyHint: 'download the per-state zip' }))
      .rejects.toThrow(/10 rows match.*estimated .*GeoJSON.*per-state zip/);
  });

  it('planExport gives the count and every format\'s estimate without reading rows', async () => {
    const { planExport } = await import('../functions/lib/parquet-export');
    const p = await planExport(file, { filters: ka });
    expect(p.total).toBe(10);
    expect(p.estimatedBytes.geojson).toBeGreaterThan(0);
    expect(p.estimatedBytes.csv).toBeGreaterThan(0);
  });
});

describe('export memory stays bounded', () => {
  // A Karnataka CSV (41,448 rows) ran a local Worker out of heap: each row
  // group's matches were read in one go with every column and the shapes.
  it('reads matches in windows of at most N rows', async () => {
    const { readWindows } = await import('../functions/lib/parquet-export');
    expect(readWindows([0, 1, 2, 5000, 5001, 9999], 1000)).toEqual([[0, 1, 2], [5000, 5001], [9999]]);
    expect(readWindows([10, 1009, 1010], 1000)).toEqual([[10, 1009], [1010]]);
    expect(readWindows([], 1000)).toEqual([]);
  });
  it('a CSV export never reads the shapes', async () => {
    const ka = [{ col: 'state', kind: 'in' as const, values: ['KA'] }];
    const csv = await collect((await exportRows(file, { filters: ka, format: 'csv' })).chunks);
    expect(csv.split('\n')[1]).not.toMatch(/POLYGON|coordinates/);
    const { readColumnsFor } = await import('../functions/lib/parquet-export');
    expect(readColumnsFor('csv', ['a'], ['xmin'])).toEqual(['a', 'xmin']);
    expect(readColumnsFor('geojson', ['a'], ['xmin'])).toEqual(['a']); // shapes are read on their own
  });
});

describe('shapes are decoded only for the matching rows (production: 128 MB Workers)', () => {
  // Groundwater prospects, 18 Nov 2026: a 159-row GeoJSON export stopped after
  // its first line. Reading 231 rows' geometry through hyparquet decoded the
  // whole 105 MB page and turned all 17,128 of its shapes into GeoJSON (1.5 GB
  // peak in Node). Now the geometry page is streamed and only matches decoded.
  // Fixture: LINESTRINGs over many pages, row i has (i % 40) + 2 points (i, k).
  const pagesBuf = readFileSync(new URL('./fixtures/wkb-pages-v1-required.parquet', import.meta.url));
  const pages = (streamed: { bytes: number }) => ({
    byteLength: pagesBuf.byteLength,
    slice: async (start: number, end?: number) =>
      pagesBuf.buffer.slice(pagesBuf.byteOffset + start, pagesBuf.byteOffset + (end ?? pagesBuf.byteLength)) as ArrayBuffer,
    async* stream(start: number, end: number) {
      for (let p = start; p < end; p += 256) {
        const piece = new Uint8Array(pagesBuf.subarray(p, Math.min(end, p + 256)));
        streamed.bytes += piece.length;
        yield piece;
      }
    },
  });
  const ids = [{ col: 'id', kind: 'range' as const, min: 200, max: 201 }];

  it('GeoJSON has the right shapes, read from a small part of the geometry column', async () => {
    const streamed = { bytes: 0 };
    const out = await exportRows(pages(streamed), { filters: ids, format: 'geojson' });
    const fc = JSON.parse(await collect(out.chunks));
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry.type).toBe('LineString');
    expect(fc.features[0].geometry.coordinates).toHaveLength(2); // 200 % 40 + 2
    expect(fc.features[1].geometry.coordinates[2]).toEqual([201, 2]);
    expect(fc.features[1].properties).toEqual({ id: 201 });
    expect(streamed.bytes).toBeGreaterThan(0);
    expect(streamed.bytes).toBeLessThan(86_874 / 3); // the group's geometry chunk
  });

  it('KML has the same rows', async () => {
    const kml = await collect((await exportRows(pages({ bytes: 0 }), { filters: ids, format: 'kml' })).chunks);
    expect(kml.match(/<Placemark>/g)).toHaveLength(2);
    expect(kml).toContain('201,2');
  });

  it('refuses up front when the shapes would take too much decoding, before any is read', async () => {
    const streamed = { bytes: 0 };
    const all = [{ col: 'id', kind: 'range' as const, min: 0, max: 599 }];
    await expect(exportRows(pages(streamed), { filters: all, format: 'geojson', maxShapeBytes: 1000 }))
      .rejects.toThrow(/Narrow the filter/);
    expect(streamed.bytes).toBe(0);
    // CSV writes no shape, so the shape budget does not apply
    await expect(exportRows(pages(streamed), { filters: all, format: 'csv', maxShapeBytes: 1000 })).resolves.toBeTruthy();
  });

  it('shapeDecodeBytes counts each group\'s geometry up to its last match', async () => {
    const { shapeDecodeBytes } = await import('../functions/lib/parquet-export');
    const meta = {
      row_groups: [100, 100].map((rows) => ({
        num_rows: rows,
        columns: [{ meta_data: { path_in_schema: ['geometry'], total_uncompressed_size: 1000 } }],
      })),
    } as never;
    expect(shapeDecodeBytes(meta, [{ last: -1 }, { last: 149 }], 'geometry')).toBe(500);
    expect(shapeDecodeBytes(meta, [{ last: 99 }, { last: -1 }], 'geometry')).toBe(1000);
  });
});
