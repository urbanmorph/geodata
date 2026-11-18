// @vitest-environment happy-dom
// Filter & export for a layer over LARGE_FILTER_BYTES runs on the API: the
// count (with each format's estimated size) is one /export?estimate=1 call,
// export is a streamed /export download, and the
// browser never hands the layer's parquet to DuckDB-WASM (a 2.3 GB parquet
// read whole crashed the tab). Smaller layers keep the DuckDB path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/db', () => ({
  query: vi.fn(async () => [{ n: 3 }]),
  getDb: vi.fn(async () => ({})),
  exportFilteredParquet: vi.fn(),
  exportFilteredGeoJSON: vi.fn(async () => new Blob(['{}'])),
  exportFilteredKML: vi.fn(),
}));
vi.mock('../src/catalog', () => ({ getCatalog: vi.fn(async () => ({ layers: [] })) }));

import * as db from '../src/db';
import { mountFilterPanel } from '../src/filter';
import type { ColumnStats } from '../src/filter-schema';

const MB = 1024 * 1024;
const PARQUET = 'https://r2.example/water/x.parquet';
const cols: ColumnStats[] = [
  { name: 'sname', type: 'string', distinct: 3, nullFrac: 0, topValues: [{ v: 'KA', n: 10 }, { v: 'MH', n: 8 }, { v: 'SK', n: 2 }] },
  { name: 'LG_2', type: 'string', distinct: 2, nullFrac: 0, topValues: [{ v: 'Pediplain', n: 12 }, { v: 'Valley', n: 8 }] },
];

function layer(bytes: number) {
  return {
    id: 'big', level: 'big', source: 'Bhuvan',
    parquet: { url: PARQUET, bytes },
    geojson: { url: 'https://r2.example/water/x.geojson.zip' },
  };
}

function mount(bytes: number) {
  document.body.innerHTML = '<div id="c"></div>';
  const onCount = vi.fn();
  mountFilterPanel(layer(bytes), document.getElementById('c')!, cols, 20, { onClose: () => {}, onCount });
  return { onCount };
}

const chip = (col: string, v: string) =>
  document.querySelector<HTMLButtonElement>(`.filter-panel__field[data-col="${col}"] .filter-chip[data-value="${v}"]`)!;
const allDbCalls = () => Object.values(db).flatMap((f) => (vi.isMockFunction(f) ? f.mock.calls : []));
const dbSawParquet = () => allDbCalls().some((args) => JSON.stringify(args).includes(PARQUET));

let fetchMock: ReturnType<typeof vi.fn>;
const plan = (total: number, geojson: number, csv = geojson / 10) =>
  new Response(JSON.stringify({ data: { total, estimated_bytes: { geojson, kml: geojson, csv } } }), { status: 200 });
let clicked: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clicked = [];
  fetchMock = vi.fn(async () => plan(7, 2_000_000));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.href);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a layer over LARGE_FILTER_BYTES', () => {
  it('counts with one estimate call carrying the filters', async () => {
    const { onCount } = mount(2300 * MB);
    chip('sname', 'KA').click();
    chip('LG_2', 'Pediplain').click();
    await vi.advanceTimersByTimeAsync(400);
    const calls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/v1/layers/'));
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0], 'http://x');
    expect(u.pathname).toBe('/api/v1/layers/big/export');
    expect(u.searchParams.get('estimate')).toBe('1');
    expect(JSON.parse(u.searchParams.get('filter')!)).toEqual([
      { col: 'sname', kind: 'in', values: ['KA'] },
      { col: 'LG_2', kind: 'in', values: ['Pediplain'] },
    ]);
    expect(onCount).toHaveBeenLastCalledWith(7);
    expect(document.querySelector('#filter-summary')!.textContent).toMatch(/7/);
  });

  it('exports by streaming from /export, and offers CSV instead of Parquet', async () => {
    mount(2300 * MB);
    expect(document.querySelector('[data-fmt="parquet"]')).toBeNull();
    chip('sname', 'SK').click();
    await vi.advanceTimersByTimeAsync(400);
    document.querySelector<HTMLButtonElement>('[data-fmt="csv"]')!.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(clicked).toHaveLength(1);
    const u = new URL(clicked[0]);
    expect(u.pathname).toBe('/api/v1/layers/big/export');
    expect(u.searchParams.get('format')).toBe('csv');
    expect(JSON.parse(u.searchParams.get('filter')!)).toEqual([{ col: 'sname', kind: 'in', values: ['SK'] }]);
  });

  it('never gives the layer parquet to DuckDB-WASM (no file read in the browser)', async () => {
    mount(2300 * MB);
    chip('sname', 'KA').click();
    await vi.advanceTimersByTimeAsync(400);
    document.querySelector<HTMLButtonElement>('[data-fmt="csv"]')!.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(dbSawParquet()).toBe(false);
    expect(vi.mocked(db.getDb)).not.toHaveBeenCalled();
  });

  it('above the export cap says so, and points a single state to the per-state zip', async () => {
    fetchMock.mockImplementation(async () => plan(60_000, 50 * MB));
    mount(2300 * MB);
    chip('sname', 'KA').click();
    await vi.advanceTimersByTimeAsync(400);
    document.querySelector<HTMLButtonElement>('[data-fmt="csv"]')!.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(clicked).toHaveLength(0);
    const msg = document.querySelector('#filter-status')!.textContent!;
    expect(msg).toMatch(/60,000/);
    expect(msg).toMatch(/50,000/);
    expect(msg).toMatch(/per-state zip/);
  });
});

describe('export size cap on a large layer', () => {
  it('a CSV estimated over the cap is refused with the estimate; under the cap it exports', async () => {
    fetchMock.mockImplementation(async () => plan(41_448, 1_440 * MB, 140 * MB));
    mount(2300 * MB);
    chip('sname', 'KA').click();
    await vi.advanceTimersByTimeAsync(400);
    document.querySelector<HTMLButtonElement>('[data-fmt="csv"]')!.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(clicked).toHaveLength(0);
    const msg = document.querySelector('#filter-status')!.textContent!;
    expect(msg).toMatch(/41,448/);
    expect(msg).toMatch(/140 MB/);
    expect(msg).toMatch(/per-state zip/);
    fetchMock.mockImplementation(async () => plan(159, 6 * MB, 1 * MB));
    chip('sname', 'KA').click(); chip('sname', 'KA').click();
    await vi.advanceTimersByTimeAsync(400);
    document.querySelector<HTMLButtonElement>('[data-fmt="csv"]')!.click();
    await vi.advanceTimersByTimeAsync(10);
    expect(clicked).toHaveLength(1);
    expect(new URL(clicked[0]).searchParams.get('format')).toBe('csv');
  });
});

describe('shape exports paused on large layers (production cut GeoJSON/KML streams off, 18 Nov 2026)', () => {
  it('the large-layer panel offers CSV only', async () => {
    mount(2300 * MB);
    expect(document.querySelector('[data-fmt="csv"]')).not.toBeNull();
    expect(document.querySelector('[data-fmt="geojson"]')).toBeNull();
    expect(document.querySelector('[data-fmt="kml"]')).toBeNull();
  });
});

describe('a layer under LARGE_FILTER_BYTES', () => {
  it('keeps the in-browser DuckDB count and export', async () => {
    mount(29 * MB);
    expect(document.querySelector('[data-fmt="parquet"]')).not.toBeNull();
    chip('sname', 'KA').click();
    await vi.advanceTimersByTimeAsync(400);
    expect(vi.mocked(db.query)).toHaveBeenCalled();
    expect(String(vi.mocked(db.query).mock.calls[0][0])).toContain(PARQUET);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/v1/layers'))).toBe(false);
  });
});
