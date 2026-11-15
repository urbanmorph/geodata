// Bulk import is idempotent when rows carry a client_id: the importer's own id
// for the row (a hospital code, a survey row number), scoped to the map. A
// re-run of the same file adds nothing; a re-run with corrected rows updates
// those rows in place (same record id); unchanged rows are left alone. Rows
// without client_id keep the old behaviour: a re-run adds them again.
//
// The import client_id is a public identifier, so it lives apart from the
// offline queue's secret client_id (records.client_key_hash): knowing an
// imported row's id must never hand anyone that record's edit token.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import * as h from '../../functions/lib/handlers';
import type { Env } from '../../functions/types';

const O = 'https://collect.test';
let env: Env & { DB: ReturnType<typeof sqliteD1> };

function req(method: string, path: string, token = '', body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`${O}/api/collect/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

type Map = { id: string; admin: string; edit: string };
async function newMap(): Promise<Map> {
  const r = await j(await h.createCollection(env, req('POST', '/collections', '', {
    name: 'Clinics', purpose: 'Clinics', license: 'CC-BY-4.0', moderation: 0,
    schema_doc: { version: 1, geometry: ['point'], fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] },
  })));
  return { id: r.body.id, admin: r.body.tokens.admin, edit: r.body.tokens.edit };
}
const pt = (name: string, client_id?: unknown, lng = 77.59) =>
  ({ geometry: { type: 'Point', coordinates: [lng, 12.97] }, properties: { name }, ...(client_id === undefined ? {} : { client_id }) });
const THREE = [pt('PHC Hebbal', 'phc-001'), pt('PHC Yelahanka', 'phc-002'), pt('PHC Jakkur', 'phc-003')];

async function importRows(m: Map, records: unknown[], extra: Record<string, unknown> = {}) {
  return j(await h.importRecords(env, req('POST', `/collections/${m.id}/import`, m.admin, {
    records, source: 'Health dept list', rights_confirmed: true, ...extra,
  }), m.id));
}
const rows = async (id: string) =>
  (await env.DB.prepare('SELECT id, properties, geometry, status, source FROM records WHERE collection_id = ? ORDER BY created_at, id').bind(id).all()).results as
    Array<{ id: string; properties: string; geometry: string; status: string; source: string }>;

beforeEach(() => {
  env = { DB: sqliteD1(), R2: {} as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' } as typeof env;
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('import with client_id', () => {
  it('the same 3 points imported twice: the second run adds nothing', async () => {
    const m = await newMap();
    const first = await importRows(m, THREE);
    expect(first.body).toMatchObject({ imported: 3, added: 3, updated: 0, unchanged: 0, total: 3 });
    const second = await importRows(m, THREE);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ imported: 0, added: 0, updated: 0, unchanged: 3, total: 3, errors: [] });
    expect(await rows(m.id)).toHaveLength(3);
  });

  it('a re-run with a corrected row updates it in place and leaves the rest', async () => {
    const m = await newMap();
    await importRows(m, THREE);
    const before = await rows(m.id);
    const fixed = [THREE[0], pt('PHC Yelahanka New Town', 'phc-002', 77.6), THREE[2]];
    const r = await importRows(m, fixed, { source: 'Health dept list' });
    expect(r.body).toMatchObject({ added: 0, updated: 1, unchanged: 2 });
    const after = await rows(m.id);
    expect(after.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort()); // same records, no new ones
    const was = before.find((x) => JSON.parse(x.properties).name === 'PHC Yelahanka')!;
    const yelahanka = after.find((x) => x.id === was.id)!;
    expect(JSON.parse(yelahanka.properties)).toEqual({ name: 'PHC Yelahanka New Town' });
    expect(JSON.parse(yelahanka.geometry).coordinates).toEqual([77.6, 12.97]);
  });

  it('a re-run with a new row adds only that one', async () => {
    const m = await newMap();
    await importRows(m, THREE);
    const r = await importRows(m, [...THREE, pt('PHC Kodigehalli', 'phc-004')]);
    expect(r.body).toMatchObject({ added: 1, updated: 0, unchanged: 3 });
    expect(await rows(m.id)).toHaveLength(4);
  });

  it('a row the owner rejected stays rejected when a re-run updates it', async () => {
    const m = await newMap();
    await importRows(m, THREE);
    const [first] = await rows(m.id);
    await h.moderateRecord(env, req('POST', `/records/${first.id}/moderate`, m.admin, { status: 'rejected' }), first.id);
    await importRows(m, [pt('PHC Hebbal (renamed)', 'phc-001')]);
    expect((await rows(m.id)).find((x) => x.id === first.id)!.status).toBe('rejected');
  });

  it('rows without client_id are added again on a re-run (the old behaviour)', async () => {
    const m = await newMap();
    await importRows(m, [pt('A'), pt('B')]);
    const r = await importRows(m, [pt('A'), pt('B')]);
    expect(r.body).toMatchObject({ imported: 2, added: 2 });
    expect(await rows(m.id)).toHaveLength(4);
  });

  it('the same client_id on another map is a different record', async () => {
    const a = await newMap();
    const b = await newMap();
    await importRows(a, THREE);
    const r = await importRows(b, THREE);
    expect(r.body).toMatchObject({ added: 3 });
  });

  it('refuses a bad client_id per row, and imports the rest', async () => {
    const m = await newMap();
    const r = await importRows(m, [pt('ok', 'ok-1'), pt('long', 'x'.repeat(129)), pt('empty', ''), pt('object', { a: 1 }), pt('ctrl', 'a\u0000b'), pt('number', 7)]);
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(1);
    expect(r.body.errors.map((e: { index: number }) => e.index)).toEqual([1, 2, 3, 4, 5]);
    expect(r.body.errors[0].error).toMatch(/client_id/);
  });

  it('refuses a client_id repeated within one import (it names the first row)', async () => {
    const m = await newMap();
    const r = await importRows(m, [pt('A', 'dup'), pt('B', 'other'), pt('C', 'dup')]);
    expect(r.body.added).toBe(2);
    expect(r.body.errors).toEqual([{ index: 2, error: 'client_id "dup" repeats row 1' }]);
  });

  it('reports added / updated / unchanged for each batch of 100', async () => {
    const m = await newMap();
    const recs = Array.from({ length: 150 }, (_, i) => pt(`P${i}`, `p-${i}`));
    await importRows(m, recs.slice(0, 120));
    recs[5] = pt('P5 fixed', 'p-5');
    const r = await importRows(m, recs);
    expect(r.body).toMatchObject({ added: 30, updated: 1, unchanged: 119 });
    expect(r.body.batches).toEqual([
      { rows: '1-100', added: 0, updated: 1, unchanged: 99 },
      { rows: '101-150', added: 30, updated: 0, unchanged: 20 },
    ]);
  });

  it('the database refuses a duplicate (map, client_id) even outside this code', async () => {
    const m = await newMap();
    await importRows(m, THREE);
    const [r] = await rows(m.id);
    expect(() => env.DB.raw.prepare(
      `INSERT INTO records (id, collection_id, created_at, status, geometry, properties, ip_hash, import_client_id)
       SELECT 'dupe', collection_id, created_at, status, geometry, properties, ip_hash, import_client_id FROM records WHERE id = ?`,
    ).run(r.id)).toThrow(/UNIQUE/);
  });

  it('an imported row’s client_id never unlocks it through the offline-queue resend', async () => {
    const m = await newMap();
    const id = 'hospital-code-0000000001'; // valid as a queue client_id too
    await importRows(m, [pt('Imported', id)]);
    const [imported] = await rows(m.id);
    const sent = await j(await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, {
      geometry: { type: 'Point', coordinates: [77.59, 12.97] }, properties: { name: 'Field' }, client_id: id,
    }), m.id));
    expect(sent.status).toBe(200);
    expect(sent.body.id).not.toBe(imported.id);
  });

  it('the log line counts updated and unchanged rows too', async () => {
    const m = await newMap();
    const pending: Promise<unknown>[] = [];
    const defer = (p: Promise<unknown>) => { pending.push(p); };
    await importRows(m, THREE);
    await h.importRecords(env, req('POST', `/collections/${m.id}/import`, m.admin, {
      records: [pt('PHC Hebbal 2', 'phc-001'), THREE[1], THREE[2]], source: 'Health dept list', rights_confirmed: true,
    }), m.id, defer);
    await Promise.all(pending);
    const [log] = (await env.DB.prepare(`SELECT detail FROM collect_attempts WHERE event = 'import' ORDER BY rowid DESC`).all()).results as Array<{ detail: string }>;
    expect(log.detail).toContain('0 of 3 rows in the file added, 1 updated, 2 unchanged');
  });
});
