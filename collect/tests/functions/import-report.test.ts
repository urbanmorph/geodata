// Bulk import (Create map & import, Manage import, the MCP's import_points):
// every row is accounted for. The response says how many were added and why
// each refused row was refused; the attempt log records the counts, the
// grouped reasons, and any rows the browser skipped before sending. Rows are
// written in batches, so a 5000-row import never runs out of database calls
// part way, and a failed write is reported with how many were saved.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import * as h from '../../functions/lib/handlers';
import type { Env } from '../../functions/types';

const O = 'https://collect.test';
let env: Env & { DB: ReturnType<typeof sqliteD1> };
let pending: Promise<unknown>[];
const defer = (p: Promise<unknown>) => { pending.push(p); };

function req(method: string, path: string, token = '', body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`${O}/api/collect/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

async function newMap() {
  const r = await j(await h.createCollection(env, req('POST', '/collections', '', {
    name: 'Footpaths', purpose: 'Rate footpaths', license: 'CC-BY-4.0',
    schema_doc: { version: 1, geometry: ['point'], fields: [
      { key: 'segment', label: 'Segment', type: 'text', required: true },
      { key: 'surface', label: 'Surface', type: 'select', options: ['Good', 'Bad'] },
    ] },
  })));
  return { id: r.body.id as string, admin: r.body.tokens.admin as string };
}
const rec = (segment: string, surface?: string) =>
  ({ geometry: { type: 'Point', coordinates: [77.59, 12.99] }, properties: { segment, ...(surface ? { surface } : {}) } });
async function importRows(m: { id: string; admin: string }, records: unknown[], extra: Record<string, unknown> = {}) {
  const r = await j(await h.importRecords(env, req('POST', `/collections/${m.id}/import`, m.admin, {
    records, source: 'Pedaluru x MCU', rights_confirmed: true, ...extra,
  }), m.id, defer));
  await Promise.all(pending);
  return r;
}
const count = async (id: string) =>
  ((await env.DB.prepare('SELECT COUNT(*) AS n FROM records WHERE collection_id = ?').bind(id).first()) as { n: number }).n;
const importLogs = async () =>
  (await env.DB.prepare(`SELECT * FROM collect_attempts WHERE event = 'import'`).all()).results as Record<string, unknown>[];

beforeEach(() => {
  env = { DB: sqliteD1(), R2: {} as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' } as typeof env;
  pending = [];
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('import report', () => {
  it('says how many were added and why each refused row was refused, with a reference', async () => {
    const m = await newMap();
    const r = await importRows(m, [rec('A', 'Good'), rec('B', 'Missing'), rec('C'), rec('', 'Bad'), rec('D', 'Missing')]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ imported: 2, total: 5, attempt_id: expect.stringMatching(/^att_/) });
    expect(r.body.errors.map((e: { index: number }) => e.index)).toEqual([1, 3, 4]);
    expect(await count(m.id)).toBe(2);
  });

  it('logs the counts, the grouped reasons and the rows the browser skipped before sending', async () => {
    const m = await newMap();
    await importRows(m, [rec('A', 'Good'), rec('B', 'Missing'), rec('D', 'Missing')], {
      client_skipped: { count: 4, reasons: [{ reason: 'no geometry (needs a geometry or lng/lat columns)', count: 4 }] },
    });
    const [log] = await importLogs();
    expect(log).toMatchObject({ outcome: 'ok', attempt_id: expect.stringMatching(/^att_/) });
    expect(String(log.detail)).toContain('1 of 7 rows in the file added'); // 3 sent + 4 skipped
    expect(String(log.detail)).toContain('Surface: "Missing" is not an allowed option (2)');
    expect(String(log.detail)).toContain('skipped in the browser: 4');
    expect(String(log.detail)).toContain('no geometry (needs a geometry or lng/lat columns) (4)');
  });

  it('writes 1200 rows in batches, not one database call per row', async () => {
    const m = await newMap();
    const batch = vi.spyOn(env.DB, 'batch');
    const r = await importRows(m, Array.from({ length: 1200 }, (_, i) => rec(`S${i}`, 'Good')));
    expect(r.body.imported).toBe(1200);
    expect(await count(m.id)).toBe(1200);
    expect(batch.mock.calls.length).toBeGreaterThan(0);
    expect(batch.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('a failed write says how many were saved, and is logged with the error', async () => {
    const m = await newMap();
    const real = env.DB.batch.bind(env.DB);
    let calls = 0;
    vi.spyOn(env.DB, 'batch').mockImplementation(async (stmts) => {
      if (++calls === 2) throw new Error('D1_ERROR: database overloaded');
      return real(stmts);
    });
    const r = await importRows(m, Array.from({ length: 250 }, (_, i) => rec(`S${i}`, 'Good')));
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ imported: 100, total: 250, attempt_id: expect.stringMatching(/^att_/) });
    expect(String(r.body.error)).toMatch(/100 of 250.*were added.*try again/i);
    expect(await count(m.id)).toBe(100);
    const [log] = await importLogs();
    expect(log).toMatchObject({ outcome: 'rejected', gate: 'persist', step: 'write_rows' });
    expect(String(log.detail)).toMatch(/database overloaded/);
  });

  it('a refused import (bad link, no source) is logged too', async () => {
    const m = await newMap();
    const r = await j(await h.importRecords(env, req('POST', `/collections/${m.id}/import`, 'adm_wrong', { records: [rec('A')], source: 'x', rights_confirmed: true }), m.id, defer));
    await Promise.all(pending);
    expect(r.status).toBe(401);
    expect(r.body.attempt_id).toMatch(/^att_/);
    expect((await importLogs())[0]).toMatchObject({ outcome: 'rejected', gate: 'auth' });
  });
});
