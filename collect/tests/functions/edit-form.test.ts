// Editing a map's form after it was created (Manage → Edit form). The rule is
// one check: every point already on the map must still be valid under the new
// form, and no field is ever removed (only hidden, which keeps its data). So
// adding options or optional fields always works; anything that would make a
// saved point invalid is refused, saying how many points and why.
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

const FORM = [
  { key: 'segment', label: 'Segment', type: 'text', required: true },
  { key: 'surface', label: 'Surface', type: 'select', options: ['Good', 'Bad', 'Uneven'] },
];
async function mapWith(points: Array<Record<string, unknown>>) {
  const r = await j(await h.createCollection(env, req('POST', '/collections', '', {
    name: 'Footpaths', purpose: 'Rate footpaths', license: 'CC-BY-4.0',
    schema_doc: { version: 1, geometry: ['point'], fields: FORM }, moderation: 0,
  })));
  const m = { id: r.body.id as string, admin: r.body.tokens.admin as string };
  if (points.length) {
    await h.importRecords(env, req('POST', `/collections/${m.id}/import`, m.admin, {
      records: points.map((properties) => ({ geometry: { type: 'Point', coordinates: [77.59, 12.99] }, properties })),
      source: 'test', rights_confirmed: true,
    }), m.id);
  }
  return m;
}
const edit = async (m: { id: string; admin: string }, fields: unknown, token = m.admin) => {
  const r = await j(await h.editForm(env, req('PATCH', `/collections/${m.id}/fields`, token, { fields }), m.id, defer));
  await Promise.all(pending);
  return r;
};
const formOf = async (m: { id: string; admin: string }) =>
  (await j(await h.getCollectionMeta(env, req('GET', `/collections/${m.id}`, m.admin), m.id))).body.schema.fields;
const POINTS = [{ segment: 'A', surface: 'Good' }, { segment: 'B', surface: 'Bad' }, { segment: 'C', surface: 'Bad' }, { segment: 'D' }];

beforeEach(() => {
  env = { DB: sqliteD1(), R2: {} as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' } as typeof env;
  pending = [];
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('edit form after create', () => {
  it('adding an option, an optional field, a label or help text always works', async () => {
    const m = await mapWith(POINTS);
    const next = [
      { ...FORM[0], label: 'Road segment', hint: 'Name the stretch' },
      { ...FORM[1], options: ['Good', 'Bad', 'Uneven', 'Missing'] },
      { key: 'seen', label: 'Seen at', type: 'datetime' },
    ];
    const r = await edit(m, next);
    expect(r.status).toBe(200);
    expect(await formOf(m)).toEqual(next);
  });

  it('refuses removing an option that points use, saying how many', async () => {
    const m = await mapWith(POINTS);
    const r = await edit(m, [FORM[0], { ...FORM[1], options: ['Good', 'Uneven'] }]);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/2 points would no longer fit/);
    expect(r.body.problems).toEqual([{ reason: 'Surface: "Bad" is not an allowed option', count: 2 }]);
    expect(await formOf(m)).toEqual(FORM); // unchanged
  });

  it('allows removing an option no point uses', async () => {
    const m = await mapWith(POINTS);
    expect((await edit(m, [FORM[0], { ...FORM[1], options: ['Good', 'Bad'] }])).status).toBe(200);
  });

  it('never removes a field; hiding one keeps its data', async () => {
    const m = await mapWith(POINTS);
    const gone = await edit(m, [FORM[0]]);
    expect(gone.status).toBe(400);
    expect(gone.body.error).toMatch(/Surface.*can't be removed.*hide it/i);
    const hidden = await edit(m, [FORM[0], { ...FORM[1], deleted: true }]);
    expect(hidden.status).toBe(200);
    const rows = (await env.DB.prepare('SELECT properties FROM records').all()).results as Array<{ properties: string }>;
    expect(rows.filter((r) => JSON.parse(r.properties).surface).length).toBe(3); // data kept
  });

  it('refuses a new required field or making a field with blanks required', async () => {
    const m = await mapWith(POINTS);
    const req1 = await edit(m, [...FORM, { key: 'width', label: 'Width', type: 'number', required: true }]);
    expect(req1.body.problems).toEqual([{ reason: 'Width is required', count: 4 }]);
    const req2 = await edit(m, [FORM[0], { ...FORM[1], required: true }]);
    expect(req2.body.problems).toEqual([{ reason: 'Surface is required', count: 1 }]);
  });

  it('allows a type change every point still fits, refuses one they do not', async () => {
    const m = await mapWith(POINTS);
    expect((await edit(m, [FORM[0], { key: 'surface', label: 'Surface', type: 'text' }])).status).toBe(200);
    const r = await edit(m, [FORM[0], { key: 'surface', label: 'Surface', type: 'number' }]);
    expect(r.status).toBe(400);
    expect(r.body.problems).toEqual([{ reason: 'Surface must be a number', count: 3 }]);
  });

  it('with no points yet, the form can change freely (fields removed too)', async () => {
    const m = await mapWith([]);
    expect((await edit(m, [{ key: 'name', label: 'Name', type: 'text' }])).status).toBe(200);
  });

  it('only the admin link can edit the form', async () => {
    const m = await mapWith(POINTS);
    expect((await edit(m, FORM, 'adm_wrong')).status).toBe(401);
  });

  it('logs every form edit, refused ones with the reasons', async () => {
    const m = await mapWith(POINTS);
    await edit(m, [FORM[0], { ...FORM[1], options: ['Good'] }]);
    const logs = (await env.DB.prepare(`SELECT * FROM collect_attempts WHERE event = 'edit_form'`).all()).results as Record<string, unknown>[];
    expect(logs[0]).toMatchObject({ outcome: 'rejected', gate: 'points' });
    expect(String(logs[0].detail)).toContain('Surface: "Bad" is not an allowed option (2)');
  });
});
