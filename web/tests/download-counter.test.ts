// The download counter used to guess a file's layer from a few key shapes and
// recognised 40 of the 522 files on offer (every .shp.zip, water/, postal/,
// reference/ and hyphenated ward folder was missed), while scanner hits like
// .php were counted. It now looks the file up in the catalog (owner, 2026-11-17).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyDownload } from '../functions/lib/r2-keys';
import { shapeDownloadCounts } from '../functions/lib/counters';

const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8'));
const FORMATS = ['parquet', 'geojson', 'kml', 'shapefile'] as const;
const keyOf = (url: string) => url.replace(/^https?:\/\/[^/]+\//, '');

describe('classifyDownload', () => {
  it('every download file in the catalog counts for its own layer and format', () => {
    const wrong: string[] = [];
    let n = 0;
    for (const l of catalog.layers) for (const f of FORMATS) {
      const url = l[f]?.url;
      if (!url || !/^https:\/\/(data\.bharatlas\.com|pub-[0-9a-f]+\.r2\.dev)\//.test(url)) continue; // the bucket, either address
      n++;
      const got = classifyDownload(keyOf(url), catalog);
      if (got?.layer_id !== l.id || got?.format !== f) wrong.push(`${keyOf(url)} -> ${JSON.stringify(got)}`);
    }
    expect(n).toBeGreaterThan(500);
    expect(wrong).toEqual([]);
  });
  it('shapefiles count as "shapefile", the name the pages read', () => {
    expect(classifyDownload('admin/states/LGD_States.shp.zip', catalog)).toEqual({ layer_id: 'lgd_states', state_code: '', format: 'shapefile' });
  });
  it('per-state extracts and other files of a baked community layer, which the catalog does not list, still count', () => {
    expect(classifyDownload('extracts/districts/29/districts_ka.parquet', catalog)).toEqual({ layer_id: 'lgd_districts', state_code: '29', format: 'parquet' });
    expect(classifyDownload('extracts/villages/07/villages_dl.shp.zip', catalog)).toEqual({ layer_id: 'lgd_villages', state_code: '07', format: 'shapefile' });
    const cat = { layers: [...catalog.layers, { id: 'c_Xa9Kp7nB' }] };
    expect(classifyDownload('community/Xa9Kp7nB/bike_lanes.csv', cat)).toEqual({ layer_id: 'c_Xa9Kp7nB', state_code: '', format: 'csv' });
  });
  it('made-up community ids and extract paths are not counted (no junk rows)', () => {
    for (const k of [
      'community/Xa9Kp7nB/bike_lanes.geojson', // not a layer
      'community/a/x.geojson', // not even a submission id
      'extracts/districts/99/x.parquet', // no such state
      'extracts/districts/123456/x.parquet',
      'extracts/districts/00/x.parquet',
      'extracts/widgets/29/x.parquet', // no lgd_widgets layer
    ]) expect(classifyDownload(k, catalog), k).toBeNull();
  });
  it('a rebaked, versioned parquet key counts for its layer (scripts/rebake_layer.py)', () => {
    const cat = { layers: [{ id: 'soi_states', parquet: { url: 'https://pub-x.r2.dev/admin/states/SOI_States.0a1b2c3d.parquet' } }] };
    expect(classifyDownload('admin/states/SOI_States.0a1b2c3d.parquet', cat)).toEqual({ layer_id: 'soi_states', state_code: '', format: 'parquet' });
  });
  it('anything else (scanner probes, unknown files) is not a download', () => {
    for (const k of ['admin/x.php', 'wp-login.php', 'community/abc/readme.md', 'admin/states/Nope.parquet', '']) {
      expect(classifyDownload(k, catalog), k).toBeNull();
    }
  });
  it('the download route classifies after the redirect, from the catalog', () => {
    const route = readFileSync(resolve(__dirname, '../functions/api/dl/[[path]].ts'), 'utf8');
    expect(route).toMatch(/waitUntil\([\s\S]*loadCatalog[\s\S]*classifyDownload/);
  });
});

describe('/api/dl/counts adds up every row for a layer and format', () => {
  it('per-state rows and the 29-day backfill rows sum instead of overwriting each other', () => {
    const out = shapeDownloadCounts([
      { layer_id: 'lgd_districts', format: 'parquet', count: 5 },
      { layer_id: 'lgd_districts', format: 'parquet', count: 3 },
      { layer_id: 'wris_dams', format: 'geojson', count: 7 },
    ]);
    expect(out).toEqual({ lgd_districts: { parquet: 8 }, wris_dams: { geojson: 7 }, _total: 15 });
  });
});

describe('the download route does not count crawlers', () => {
  it('a bot is redirected without a count; a person is counted', async () => {
    const { onRequestGet } = await import('../functions/api/dl/[[path]]');
    const run = async (ua: string) => {
      const waits: Promise<unknown>[] = [];
      const r = await onRequestGet({
        request: new Request('https://bharatlas.com/api/dl/admin/states/LGD_States.parquet', { headers: { 'user-agent': ua } }),
        params: { path: ['admin', 'states', 'LGD_States.parquet'] },
        env: { DB: {}, ASSETS: { fetch: async () => new Response('{"layers":[]}') } },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      } as never);
      expect(r.status).toBe(302);
      return waits.length;
    };
    expect(await run('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(0);
    expect(await run('Mozilla/5.0 (Macintosh) Firefox/130')).toBe(1);
  });

  it('one address is counted at most DL_COUNT_PER_MINUTE times a minute; it is still redirected', async () => {
    const { onRequestGet } = await import('../functions/api/dl/[[path]]');
    const { DL_COUNT_PER_MINUTE } = await import('../functions/lib/counters');
    const { __resetApiLimiterForTest } = await import('../functions/lib/api-ratelimit');
    __resetApiLimiterForTest();
    (await import('../functions/lib/catalog-loader')).__resetCatalogForTest();
    const cat = { layers: [{ id: 'lgd_states', parquet: { url: 'https://pub-x.r2.dev/admin/states/LGD_States.parquet' } }] };
    let bumps = 0;
    const db = { prepare: () => ({ bind: () => ({ run: async () => { bumps++; } }) }) };
    for (let i = 0; i < DL_COUNT_PER_MINUTE + 5; i++) {
      const waits: Promise<unknown>[] = [];
      const r = await onRequestGet({
        request: new Request('https://bharatlas.com/api/dl/admin/states/LGD_States.parquet', { headers: { 'user-agent': 'Firefox/130', 'cf-connecting-ip': '203.0.113.50' } }),
        params: { path: ['admin', 'states', 'LGD_States.parquet'] },
        env: { DB: db, ASSETS: { fetch: async () => new Response(JSON.stringify(cat)) } },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      } as never);
      await Promise.all(waits);
      expect(r.status).toBe(302);
    }
    expect(bumps).toBe(DL_COUNT_PER_MINUTE);
  });
});
