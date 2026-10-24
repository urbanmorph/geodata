// When a point was captured. Every point already had the server's time, but a
// point saved offline is sent later, so that was when the phone got signal
// back, not when the contributor stood there. The phone now sends its capture
// time; the server keeps it when it is plausible and falls back to its own.
// Downloads and published data carry it as added_at.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import * as h from '../../functions/lib/handlers';
import type { Env } from '../../functions/types';

const O = 'https://collect.test';
let env: Env & { DB: ReturnType<typeof sqliteD1> };
let objects: Map<string, string>;

function req(method: string, path: string, token = '', body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`${O}/api/collect/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

async function newMap() {
  const r = await j(await h.createCollection(env, req('POST', '/collections', '', {
    name: 'Ward trees', purpose: 'Street trees', license: 'CC-BY-4.0',
    schema_doc: { version: 1, geometry: ['point'], fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] },
    moderation: 0,
  })));
  return { id: r.body.id as string, edit: r.body.tokens.edit as string, admin: r.body.tokens.admin as string };
}
const point = { type: 'Point', coordinates: [77.59, 12.97] };
const add = async (m: { id: string; edit: string }, extra: Record<string, unknown> = {}) =>
  j(await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, { geometry: point, properties: { name: 'Neem' }, ...extra }), m.id));
const listed = async (m: { id: string; admin: string }) =>
  (await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records`, m.admin), m.id))).body.features[0].properties;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  objects = new Map();
  const r2 = {
    async put(key: string, body: ArrayBuffer | string) {
      const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
      objects.set(key, text);
      return { key, size: new TextEncoder().encode(text).byteLength };
    },
    async delete() {},
  };
  env = { DB: sqliteD1(), R2: r2 as unknown as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' } as typeof env;
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('captured_at', () => {
  it('keeps the time the phone captured an offline point', async () => {
    const m = await newMap();
    const when = ago(3 * 3600_000);
    await add(m, { captured_at: when });
    expect((await listed(m))._captured_at).toBe(when);
  });

  it('ignores a time in the future, too old, or not a time at all (the server time stands)', async () => {
    for (const bad of [new Date(Date.now() + 3600_000).toISOString(), ago(400 * 86400_000), 'yesterday', 42]) {
      const m = await newMap();
      const r = await add(m, { captured_at: bad });
      expect(r.status).toBe(200);
      const p = await listed(m);
      expect(p._captured_at).toBeNull();
      expect(p._created_at).toEqual(expect.any(String));
    }
  });

  it('published data carries added_at for every point', async () => {
    const m = await newMap();
    const when = ago(3600_000);
    await add(m, { captured_at: when });
    const pub = await j(await h.publish(env, req('POST', `/collections/${m.id}/publish`, m.admin, {}), m.id));
    expect(pub.status).toBe(200);
    const geojson = [...objects].find(([k]) => k.endsWith('.geojson'))![1];
    expect(JSON.parse(geojson).features[0].properties.added_at).toBe(when);
  });

  it("an author's own added_at field is never overwritten", async () => {
    const r = await j(await h.createCollection(env, req('POST', '/collections', '', {
      name: 'Ward trees', purpose: 'Street trees', license: 'CC-BY-4.0',
      schema_doc: { version: 1, geometry: ['point'], fields: [{ key: 'added_at', label: 'Added', type: 'text' }] },
      moderation: 0,
    })));
    const m = { id: r.body.id, edit: r.body.tokens.edit, admin: r.body.tokens.admin };
    await j(await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, { geometry: point, properties: { added_at: 'mine' } }), m.id));
    await h.publish(env, req('POST', `/collections/${m.id}/publish`, m.admin, {}), m.id);
    const geojson = [...objects].find(([k]) => k.endsWith('.geojson'))![1];
    expect(JSON.parse(geojson).features[0].properties.added_at).toBe('mine');
  });
});
