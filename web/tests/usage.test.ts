// Proof of use beyond downloads (owner, 2026-11-17): count API and MCP calls
// that name a layer, show them with downloads on the layer page. Honest
// numbers: crawlers and our own smoke test don't count; downloads made from
// the map page now go through the counter like the /layers rows.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { usageChannel, incrementApiUse, shapeUsage, usageLine } from '../functions/lib/usage';
import { availableDownloads } from '../src/format-hints';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');

describe('usageChannel', () => {
  it('the bharatlas MCP is "mcp"; browsers, curl and scripts are "api"', () => {
    expect(usageChannel('bharatlas-mcp/1.6.0')).toBe('mcp');
    expect(usageChannel('Mozilla/5.0 (Macintosh)')).toBe('api');
    expect(usageChannel('curl/8.4.0')).toBe('api');
    expect(usageChannel(null)).toBe('api');
  });
  it('crawlers and our own smoke test are not counted', () => {
    expect(usageChannel('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBeNull();
    expect(usageChannel('GPTBot/1.1')).toBeNull();
    expect(usageChannel('bharatlas-mcp-test')).toBeNull();
  });
});

describe('incrementApiUse', () => {
  // Both counters in one round trip: the running total (layer-page line) and a
  // UTC-day row, so ops can show the last 30 days. No caller data in either.
  const fakeDb = () => {
    const batches: { sql: string; args: unknown[] }[][] = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }),
      batch: async (stmts: { sql: string; args: unknown[] }[]) => { batches.push(stmts); return []; },
    };
    return { db, batches };
  };
  it('upserts the running total and the day row in one batch', async () => {
    const { db, batches } = fakeDb();
    await incrementApiUse(db as never, 'lgd_states', 'mcp', new Date('2026-11-18T23:59:59Z'));
    expect(batches).toHaveLength(1);
    const [total, daily] = batches[0];
    expect(total.sql).toMatch(/INSERT INTO api_usage[\s\S]*ON CONFLICT\(layer_id, channel\)[\s\S]*count = count \+ 1/);
    expect(total.args.slice(0, 2)).toEqual(['lgd_states', 'mcp']);
    expect(daily.sql).toMatch(/INSERT INTO api_usage_daily[\s\S]*ON CONFLICT\(day, layer_id, channel\)[\s\S]*count = count \+ 1/);
    expect(daily.args).toEqual(['2026-11-18', 'lgd_states', 'mcp']);
  });
  it('the day is the UTC date', async () => {
    const { db, batches } = fakeDb();
    await incrementApiUse(db as never, 'x', 'api', new Date('2026-11-19T02:00:00+05:30'));
    expect(batches[0][1].args[0]).toBe('2026-11-18');
  });
});

describe('shapeUsage', () => {
  it('per layer: downloads, api, mcp; and the totals', () => {
    const out = shapeUsage(
      [{ layer_id: 'a', count: 5 }, { layer_id: 'b', count: 2 }],
      [{ layer_id: 'a', channel: 'api', count: 7 }, { layer_id: 'a', channel: 'mcp', count: 3 }],
    );
    expect(out.layers.a).toEqual({ downloads: 5, api: 7, mcp: 3 });
    expect(out.layers.b).toEqual({ downloads: 2, api: 0, mcp: 0 });
    expect(out.total).toEqual({ downloads: 7, api: 7, mcp: 3 });
  });
});

describe('usageLine', () => {
  it('downloads, then API queries with the MCP share, short numbers', () => {
    expect(usageLine({ downloads: 1234, api: 3400, mcp: 900 })).toBe('1.2k downloads · 4.3k API queries (900 via MCP)');
    expect(usageLine({ downloads: 1, api: 0, mcp: 0 })).toBe('1 download');
    expect(usageLine({ downloads: 0, api: 2, mcp: 0 })).toBe('2 API queries');
    expect(usageLine({ downloads: 0, api: 0, mcp: 0 })).toBe('');
  });
});

describe('the API counts calls that name a layer', () => {
  const route = (f: string) => read(`functions/api/v1/${f}`);
  for (const f of ['layers/[id].ts', 'layers/[id]/query.ts', 'layers/[id]/schema.ts', 'layers/[id]/counts.ts', 'nearby.ts']) {
    it(f, () => expect(route(f)).toMatch(/countApiUse\(ctx, /));
  }
  it('/api/v1/usage serves the counts', () => {
    expect(route('usage.ts')).toMatch(/shapeUsage\(/);
  });
  it('the table exists', () => {
    expect(read('migrations/0017_api_usage.sql')).toMatch(/CREATE TABLE IF NOT EXISTS api_usage[\s\S]*PRIMARY KEY \(layer_id, channel\)/);
  });
});

describe('downloads from the map page are counted', () => {
  it('data files go through /api/dl; map tiles stay direct', () => {
    const d = availableDownloads({
      parquet: { url: 'https://pub-x.r2.dev/admin/s.parquet', bytes: 1 },
      pmtiles: { url: 'https://pub-x.r2.dev/admin/s.pmtiles', bytes: 1 },
    });
    expect(d.find((x) => x.fmt === 'parquet')?.url).toBe('/api/dl/admin/s.parquet');
    expect(d.find((x) => x.fmt === 'pmtiles')?.url).toBe('https://pub-x.r2.dev/admin/s.pmtiles');
  });
});
