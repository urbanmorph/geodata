// Fixes from the code review of the data-aware forms change.
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
const FORM = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'phone', label: 'Phone', type: 'text' },
];
async function newMap(fields: unknown = FORM) {
  const r = await j(await h.createCollection(env, req('POST', '/collections', '', {
    name: 'Shops', purpose: 'Shops', license: 'CC-BY-4.0', schema_doc: { version: 1, geometry: ['point'], fields }, moderation: 0,
  })));
  return { id: r.body.id as string, edit: r.body.tokens?.edit as string, admin: r.body.tokens?.admin as string, status: r.status, error: r.body.error };
}
const point = { type: 'Point', coordinates: [77.59, 12.97] };
const stored = async () => JSON.parse(((await env.DB.prepare('SELECT properties FROM records').first()) as { properties: string }).properties);

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
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('hidden fields keep their data', () => {
  it('editing a point after a field was hidden keeps the hidden value', async () => {
    const m = await newMap();
    const add = await j(await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, { geometry: point, properties: { name: 'Kiosk', phone: '98450' } }), m.id));
    await h.editForm(env, req('PATCH', `/collections/${m.id}/fields`, m.admin, { fields: [FORM[0], { ...FORM[1], deleted: true }] }), m.id);
    const r = await h.editRecord(env, req('PATCH', `/records/${add.body.id}`, add.body.edit_token, { properties: { name: 'Kiosk 2' } }), add.body.id);
    expect(r.status).toBe(200);
    expect(await stored()).toEqual({ name: 'Kiosk 2', phone: '98450' });
  });

  it('a hidden field is not published', async () => {
    const m = await newMap();
    await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, { geometry: point, properties: { name: 'Kiosk', phone: '98450' } }), m.id);
    await h.editForm(env, req('PATCH', `/collections/${m.id}/fields`, m.admin, { fields: [FORM[0], { ...FORM[1], deleted: true }] }), m.id);
    expect((await j(await h.publish(env, req('POST', `/collections/${m.id}/publish`, m.admin, {}), m.id))).status).toBe(200);
    const props = JSON.parse([...objects].find(([k]) => k.endsWith('.geojson'))![1]).features[0].properties;
    expect(props.name).toBe('Kiosk');
    expect(props).not.toHaveProperty('phone');
  });
});

describe('hidden fields are not shown to shared links', () => {
  it('a view or collect link does not receive hidden values; the admin still does', async () => {
    const m = await newMap();
    await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, { geometry: point, properties: { name: 'Kiosk', phone: '98450' } }), m.id);
    await h.editForm(env, req('PATCH', `/collections/${m.id}/fields`, m.admin, { fields: [FORM[0], { ...FORM[1], deleted: true }] }), m.id);
    const shared = await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records`, m.edit), m.id));
    expect(shared.body.features[0].properties).not.toHaveProperty('phone');
    const admin = await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records`, m.admin), m.id));
    expect(admin.body.features[0].properties.phone).toBe('98450');
  });
});

describe('form fields are stored only as known, typed settings', () => {
  it('refuses a min/max that is not a number (it is written into the page)', async () => {
    const m = await newMap([{ key: 'n', label: 'N', type: 'number', min: '"><img src=x onerror=alert(1)>' }]);
    expect(m.status).toBe(400);
    expect(m.error).toMatch(/min must be a number/);
  });

  it('drops unknown keys and checks the type of each known one', async () => {
    const m = await newMap([{ key: 'n', label: 'N', type: 'number', integer: true, min: 0, max: 9, hint: 'How many', junk: '<b>' }]);
    const meta = await j(await h.getCollectionMeta(env, req('GET', `/collections/${m.id}`, m.admin), m.id));
    expect(meta.body.schema.fields[0]).toEqual({ key: 'n', label: 'N', type: 'number', integer: true, min: 0, max: 9, hint: 'How many' });
    const { validateSchemaDoc } = await import('../../src/schema/validate-collection');
    for (const bad of [{ required: 'yes' }, { maxLength: -1 }, { hint: 'x'.repeat(600) }, { render: 'table' }, { deleted: 1 }, { min: 1 }]) {
      expect(validateSchemaDoc({ version: 1, geometry: ['point'], fields: [{ key: 'n', label: 'N', type: 'text', ...bad }] }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('edit form checks every point, however many', () => {
  it('checks points beyond any page size', async () => {
    const m = await newMap([{ key: 'kind', label: 'Kind', type: 'select', options: ['A', 'B'] }]);
    const records = Array.from({ length: 2600 }, (_, i) => ({ geometry: point, properties: { kind: i === 0 ? 'B' : 'A' } }));
    for (let i = 0; i < records.length; i += 2000) {
      await h.importRecords(env, req('POST', `/collections/${m.id}/import`, m.admin, { records: records.slice(i, i + 2000), source: 's', rights_confirmed: true }), m.id);
    }
    // 'B' is used only by the very first (oldest) point
    const r = await j(await h.editForm(env, req('PATCH', `/collections/${m.id}/fields`, m.admin, { fields: [{ key: 'kind', label: 'Kind', type: 'select', options: ['A'] }] }), m.id));
    expect(r.status).toBe(400);
    expect(r.body.problems).toEqual([{ reason: 'Kind: "B" is not an allowed option', count: 1 }]);
  });

  it('records can be listed page by page past 2000', async () => {
    const m = await newMap([{ key: 'kind', label: 'Kind', type: 'text' }]);
    await h.importRecords(env, req('POST', `/collections/${m.id}/import`, m.admin, { records: Array.from({ length: 2100 }, () => ({ geometry: point, properties: { kind: 'x' } })), source: 's', rights_confirmed: true }), m.id);
    const p1 = await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records?limit=2000&offset=0`, m.admin), m.id));
    const p2 = await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records?limit=2000&offset=2000`, m.admin), m.id));
    expect(p1.body.features.length + p2.body.features.length).toBe(2100);
  });
});

describe('a failed import says exactly which rows were not saved', () => {
  it('returns the refused rows and the indices of valid rows that were not saved', async () => {
    const m = await newMap();
    const recs = Array.from({ length: 250 }, (_, i) => ({ geometry: point, properties: i === 5 ? {} : { name: `S${i}` } }));
    const real = env.DB.batch.bind(env.DB);
    let calls = 0;
    vi.spyOn(env.DB, 'batch').mockImplementation(async (s) => { if (++calls === 2) throw new Error('D1_ERROR: overloaded'); return real(s); });
    const r = await j(await h.importRecords(env, req('POST', `/collections/${m.id}/import`, m.admin, { records: recs, source: 's', rights_confirmed: true }), m.id));
    expect(r.status).toBe(500);
    expect(r.body.errors).toEqual([{ index: 5, error: 'Name is required' }]);
    // valid rows: 0-4, 6-249 (249 of them); the first batch saved 100 (rows 0-4, 6-100)
    expect(r.body.not_saved[0]).toBe(101);
    expect(r.body.not_saved).toHaveLength(149);
  });
});

describe('untrusted numbers and times are normalised', () => {
  it('a capture time is stored in one ISO format', () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    expect(h.plausibleCaptureTime('2026-10-24T09:30:00+05:30', now)).toBe('2026-10-24T04:00:00.000Z');
  });
});
