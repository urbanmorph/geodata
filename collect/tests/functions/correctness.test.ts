// Data-integrity and reliability fixes from the collect code review: bulk
// approve in one transaction, stable paging, a retried save that keeps its
// photos, rate limits that don't race, the landing counter cached, and the
// router answering JSON when something throws.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import { req, j, makeMap } from './helpers/api';
import * as h from '../../functions/lib/handlers';
import * as ph from '../../functions/lib/photos';
import { checkRecordRate } from '../../functions/lib/ratelimit';
import { onRequest } from '../../functions/api/collect/[[path]]';
import type { Env } from '../../functions/types';

type TestEnv = Env & { DB: ReturnType<typeof sqliteD1> };
let env: TestEnv;
let objects: Map<string, Uint8Array>;


const FIELDS = [{ key: 'name', label: 'Name', type: 'text', required: true }];
const newMap = (opts: { moderation?: number; fields?: unknown[]; mode?: string } = {}) =>
  makeMap(env, { fields: FIELDS, moderation: 1, ...opts });
type M = Awaited<ReturnType<typeof newMap>>;
const point = { type: 'Point', coordinates: [77.59, 12.97] };

/** Adds n points straight into the table (fast, and with chosen created_at). */
function seed(m: M, n: number, status = 'pending', createdAt = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString()) {
  const ins = env.DB.raw.prepare(`INSERT INTO records (id, collection_id, created_at, status, geometry, properties, edit_token_hash, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, 'x', 'ip')`);
  for (let i = 0; i < n; i++) ins.run(`rec${String(i).padStart(6, '0')}`, m.id, createdAt(i), status, JSON.stringify(point), JSON.stringify({ name: `T${i}` }));
}
const statuses = (m: M) => env.DB.raw.prepare('SELECT status, COUNT(*) AS n FROM records WHERE collection_id = ? GROUP BY status').all(m.id) as Array<{ status: string; n: number }>;

beforeEach(() => {
  objects = new Map();
  const r2 = {
    async put(key: string, body: ArrayBuffer | Uint8Array | string) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body as ArrayBuffer);
      objects.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    async get(key: string) { const b = objects.get(key); return b ? { body: b, arrayBuffer: async () => b.slice().buffer } : null; },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
  };
  env = { DB: sqliteD1(), R2: r2 as unknown as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' } as TestEnv;
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Approve all', () => {
  it('approves every ready point in one transaction, within the per-request query limit', async () => {
    const m = await newMap();
    seed(m, 600);
    // D1 answers at most so many queries per request; count every statement run.
    let queries = 0;
    const real = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      const st = real(sql);
      const count = <T extends (...a: any[]) => any>(f: T) => ((...a: any[]) => { if (++queries > 50) throw new Error('Too many API requests by single worker invocation'); return f(...a); }) as T;
      st.run = count(st.run); st.first = count(st.first); st.all = count(st.all);
      return st;
    }) as typeof env.DB.prepare;
    const r = await j(await h.moderateAll(env, req('POST', `/collections/${m.id}/moderate-all`, m.admin, {}), m.id));
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(600);
    expect(statuses(m)).toEqual([{ status: 'published', n: 600 }]);
  });

  it('a failure leaves no point half-approved', async () => {
    const m = await newMap();
    seed(m, 10);
    env.DB.batch = (async () => { throw new Error('D1 down'); }) as typeof env.DB.batch;
    await expect(h.moderateAll(env, req('POST', `/collections/${m.id}/moderate-all`, m.admin, {}), m.id)).rejects.toThrow();
    expect(statuses(m)).toEqual([{ status: 'pending', n: 10 }]);
  });

  it('still skips points whose answers are not filled in', async () => {
    const m = await newMap();
    seed(m, 3);
    env.DB.raw.prepare(`UPDATE records SET properties = '{}' WHERE id = 'rec000001'`).run();
    const r = await j(await h.moderateAll(env, req('POST', `/collections/${m.id}/moderate-all`, m.admin, {}), m.id));
    expect(r.body).toMatchObject({ changed: 2, skipped: 1 });
    expect((env.DB.raw.prepare(`SELECT status FROM records WHERE id = 'rec000001'`).get() as { status: string }).status).toBe('pending');
  });
});

describe('the router', () => {
  it('answers a JSON 500 when a handler throws, not a bare error page', async () => {
    const m = await newMap();
    env.DB.batch = (async () => { throw new Error('D1 down'); }) as typeof env.DB.batch;
    seed(m, 2);
    const request = req('POST', `/collections/${m.id}/moderate-all`, m.admin, {});
    const res = await onRequest({ request, env, params: { path: ['v1', 'collections', m.id, 'moderate-all'] }, waitUntil: () => {} } as never);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect(((await res.json()) as { error: string }).error).toMatch(/went wrong/i);
  });
});

describe('paging the records', () => {
  const page = async (m: M, qs: string) => (await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records?${qs}`, m.admin), m.id))).body;

  it('orders points saved in the same millisecond by id, so pages never overlap', async () => {
    const m = await newMap();
    seed(m, 5, 'published', () => '2026-10-01T00:00:00.000Z');
    const ids = [...(await page(m, 'limit=2&offset=0')).features, ...(await page(m, 'limit=2&offset=2')).features, ...(await page(m, 'limit=2&offset=4')).features].map((f: { id: string }) => f.id);
    expect(ids).toEqual(['rec000004', 'rec000003', 'rec000002', 'rec000001', 'rec000000']);
  });

  it('a cursor (after) continues where the last page ended, even when new points arrive between pages', async () => {
    const m = await newMap();
    seed(m, 5, 'published');
    const first = await page(m, 'limit=2');
    expect(first.features.map((f: { id: string }) => f.id)).toEqual(['rec000004', 'rec000003']);
    expect(typeof first.next).toBe('string');
    // A new point arrives: with offset paging, rec000003 would come again.
    env.DB.raw.prepare(`INSERT INTO records (id, collection_id, created_at, status, geometry, properties, edit_token_hash, ip_hash)
      VALUES ('zzznew', ?, '2026-11-01T00:00:00.000Z', 'published', ?, '{"name":"New"}', 'x', 'ip')`).run(m.id, JSON.stringify(point));
    const second = await page(m, `limit=2&after=${encodeURIComponent(first.next)}`);
    expect(second.features.map((f: { id: string }) => f.id)).toEqual(['rec000002', 'rec000001']);
    const third = await page(m, `limit=2&after=${encodeURIComponent(second.next)}`);
    expect(third.features.map((f: { id: string }) => f.id)).toEqual(['rec000000']);
    expect(third.next).toBeNull();
  });

  it('a malformed cursor is refused', async () => {
    const m = await newMap();
    const r = await h.listRecords(env, req('GET', `/collections/${m.id}/records?after=nonsense`, m.admin), m.id);
    expect(r.status).toBe(400);
  });

  it('without paging parameters it answers as before (the MCP get_records tool)', async () => {
    const m = await newMap();
    seed(m, 3, 'published');
    const r = await page(m, '');
    expect(r.type).toBe('FeatureCollection');
    expect(r.features).toHaveLength(3);
  });

  it('catches up on photo notes only with the first page, not on every page', async () => {
    const m = await newMap({ mode: 'form_ai', fields: [...FIELDS, { key: 'pic', label: 'Photo', type: 'photo' }] });
    seed(m, 3, 'published');
    const defer = vi.fn();
    await h.listRecords(env, req('GET', `/collections/${m.id}/records?limit=1`, m.admin), m.id, defer);
    expect(defer).toHaveBeenCalledTimes(1);
    const first = await page(m, 'limit=1');
    await h.listRecords(env, req('GET', `/collections/${m.id}/records?limit=1&after=${encodeURIComponent(first.next)}`, m.admin), m.id, defer);
    await h.listRecords(env, req('GET', `/collections/${m.id}/records?limit=1&offset=1`, m.admin), m.id, defer);
    expect(defer).toHaveBeenCalledTimes(1);
  });
});

describe('a queued point sent again after its first save', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xd9]);
  it('claims its photos, so they are not cleared as abandoned', async () => {
    const m = await newMap({ moderation: 0, fields: [...FIELDS, { key: 'pic', label: 'Photo', type: 'photo' }] });
    const up = await j(await ph.uploadPhoto(env, req('POST', `/collections/${m.id}/photos`, m.edit, JPEG, { 'x-client-id': 'photo-client-0000001' }), m.id));
    const body = { geometry: point, properties: { name: 'Neem', pic: [up.body.id] }, client_id: 'Qm9vZ2llV29vZ2llMTIzNDU2' };
    const first = await j(await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, body), m.id));
    expect(first.status).toBe(200);
    // The first save stopped after the insert (the worker was cut off before the claim).
    env.DB.raw.prepare('UPDATE collect_photos SET record_id = NULL').run();
    const again = await j(await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, body), m.id));
    expect(again.body.id).toBe(first.body.id);
    expect((env.DB.raw.prepare('SELECT record_id FROM collect_photos WHERE id = ?').get(up.body.id) as { record_id: string }).record_id).toBe(first.body.id);
  });
});

describe('rate limits', () => {
  it('two first requests at once both count, and neither fails', async () => {
    const results = await Promise.all([checkRecordRate(env.DB, 'k1'), checkRecordRate(env.DB, 'k1')]);
    expect(results).toEqual([true, true]);
    expect((env.DB.raw.prepare(`SELECT hour_count FROM rate_limits WHERE ip_hash = 'k1'`).get() as { hour_count: number }).hour_count).toBe(2);
  });

  it('stops at the limit and starts again after the hour', async () => {
    for (let i = 0; i < 200; i++) expect(await checkRecordRate(env.DB, 'k2')).toBe(true);
    expect(await checkRecordRate(env.DB, 'k2')).toBe(false);
    env.DB.raw.prepare(`UPDATE rate_limits SET hour_window_start = ? WHERE ip_hash = 'k2'`).run(new Date(Date.now() - 3_700_000).toISOString());
    expect(await checkRecordRate(env.DB, 'k2')).toBe(true);
    expect((env.DB.raw.prepare(`SELECT hour_count FROM rate_limits WHERE ip_hash = 'k2'`).get() as { hour_count: number }).hour_count).toBe(1);
  });

  it('points per hour are counted per link and network, so two teams behind one mobile network do not share a budget', async () => {
    const a = await newMap({ moderation: 0 });
    const b = await newMap({ moderation: 0 });
    const add = (m: M) => h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, { geometry: point, properties: { name: 'Neem' } }), m.id);
    // Team A uses up its hour (both teams share one public IP).
    const rows = () => env.DB.raw.prepare(`SELECT ip_hash, hour_count FROM rate_limits WHERE hour_count > 0`).all() as Array<{ ip_hash: string; hour_count: number }>;
    expect((await add(a)).status).toBe(200);
    const [keyA] = rows();
    env.DB.raw.prepare('UPDATE rate_limits SET hour_count = 200 WHERE ip_hash = ?').run(keyA.ip_hash);
    expect((await add(a)).status).toBe(429);
    expect((await add(b)).status).toBe(200);
  });
});

describe('the landing counter', () => {
  it('is cached for a few minutes, so a visit does not count the whole table', async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', { default: {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => void store.set(r.url, res.clone()),
    } });
    const m = await newMap({ moderation: 0 });
    seed(m, 2, 'published');
    const waits: Promise<unknown>[] = [];
    const first = await j(await h.getStats(env, req('GET', '/stats'), (p) => waits.push(p)));
    await Promise.all(waits);
    expect(first.body.points).toBe(2);
    let queried = false;
    const real = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => { queried = true; return real(sql); }) as typeof env.DB.prepare;
    const second = await j(await h.getStats(env, req('GET', '/stats'), () => {}));
    expect(second.body.points).toBe(2);
    expect(queried).toBe(false);
  });

  it('does not claim a count of people (an IP hash per day is not a person)', async () => {
    const body = (await j(await h.getStats(env, req('GET', '/stats')))).body;
    expect(body).not.toHaveProperty('contributors');
    expect(body).toMatchObject({ maps: 0, points: 0, states: 0 });
  });
});
