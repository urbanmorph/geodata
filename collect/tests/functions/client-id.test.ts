// Offline capture queue: a phone may send the same point twice (it saved, but the
// reply was lost to a dropped connection). Each queued point carries a random
// client_id; a repeat returns the same record instead of a duplicate, with a fresh
// edit token, since only the hash of the first one is stored. Additive: callers
// without client_id (the MCP, older clients) are unchanged.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import * as h from '../../functions/lib/handlers';
import type { Env } from '../../functions/types';

const O = 'https://collect.test';
let env: Env;

function req(method: string, path: string, token = '', body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`${O}/api/collect/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

async function newMap(): Promise<{ id: string; edit: string }> {
  const r = await j(await h.createCollection(env, req('POST', '/collections', '', {
    name: 'Ward trees', purpose: 'Street trees', license: 'CC-BY-4.0',
    schema_doc: { version: 1, geometry: ['point'], fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] },
    moderation: 0,
  })));
  expect(r.status).toBe(200);
  return { id: r.body.id, edit: r.body.tokens.edit };
}
const point = { type: 'Point', coordinates: [77.59, 12.97] };
const CLIENT_ID = 'Qm9vZ2llV29vZ2llMTIzNDU2';
const add = async (m: { id: string; edit: string }, extra: Record<string, unknown> = {}) =>
  j(await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, { geometry: point, properties: { name: 'Neem' }, ...extra }), m.id));
const count = async (id: string) =>
  ((await env.DB.prepare('SELECT COUNT(*) AS n FROM records WHERE collection_id = ?').bind(id).first()) as { n: number }).n;
const canEdit = async (recordId: string, token: string) =>
  (await h.getRecordForEdit(env, req('GET', `/records/${recordId}`, token), recordId)).status === 200;

beforeEach(() => {
  env = { DB: sqliteD1(), R2: {} as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' };
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 })); // no network in tests
});

describe('a queued point sent twice', () => {
  it('is saved once; the repeat returns the same record', async () => {
    const m = await newMap();
    const first = await add(m, { client_id: CLIENT_ID });
    const again = await add(m, { client_id: CLIENT_ID });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.status).toBe(first.body.status);
    expect(await count(m.id)).toBe(1);
  });

  it('the repeat carries a fresh edit token that works (the first one is replaced)', async () => {
    const m = await newMap();
    const first = await add(m, { client_id: CLIENT_ID });
    const again = await add(m, { client_id: CLIENT_ID });
    expect(again.body.edit_token).not.toBe(first.body.edit_token);
    expect(await canEdit(first.body.id, again.body.edit_token)).toBe(true);
    expect(await canEdit(first.body.id, first.body.edit_token)).toBe(false);
  });

  it('a repeat is not counted against the hourly record limit', async () => {
    const m = await newMap();
    await add(m, { client_id: CLIENT_ID });
    for (let i = 0; i < 5; i++) await add(m, { client_id: CLIENT_ID });
    const row = (await env.DB.prepare('SELECT hour_count FROM rate_limits').first()) as { hour_count: number };
    expect(row.hour_count).toBe(1);
  });

  it('different client_ids are different points', async () => {
    const m = await newMap();
    await add(m, { client_id: CLIENT_ID });
    await add(m, { client_id: 'b'.repeat(22) });
    expect(await count(m.id)).toBe(2);
  });

  it('the same client_id on another map is a different point', async () => {
    const a = await newMap();
    const b = await newMap();
    expect((await add(a, { client_id: CLIENT_ID })).status).toBe(200);
    expect((await add(b, { client_id: CLIENT_ID })).status).toBe(200);
    expect(await count(b.id)).toBe(1);
  });

  it('rejects a malformed client_id rather than ignoring it', async () => {
    const m = await newMap();
    expect((await add(m, { client_id: 'short' })).status).toBe(400);
    expect((await add(m, { client_id: 42 })).status).toBe(400);
    expect(await count(m.id)).toBe(0);
  });

  it('without client_id nothing changes: each call adds a point', async () => {
    const m = await newMap();
    await add(m);
    await add(m);
    expect(await count(m.id)).toBe(2);
  });

  it('stores only a hash of the client_id', async () => {
    const m = await newMap();
    await add(m, { client_id: CLIENT_ID });
    const row = JSON.stringify(await env.DB.prepare('SELECT * FROM records').first());
    expect(row).not.toContain(CLIENT_ID);
  });
});
