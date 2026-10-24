// Photos on points: uploaded first, claimed by the point that uses them, private
// until the point is approved, deleted with it. And the model's notes: written
// after upload within a daily allowance, kept apart until a person accepts them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import * as h from '../../functions/lib/handlers';
import * as ph from '../../functions/lib/photos';
import * as ai from '../../functions/lib/ai';
import type { Env } from '../../functions/types';

const O = 'https://collect.test';
type TestEnv = Env & { DB: ReturnType<typeof sqliteD1> };
let env: TestEnv;
let objects: Map<string, Uint8Array>;
let aiCalls: unknown[];
let aiReply: string;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xd9]);

function req(method: string, path: string, token = '', body?: unknown, headers: Record<string, string> = {}): Request {
  const hd: Record<string, string> = { ...headers };
  if (token) hd.authorization = `Bearer ${token}`;
  let b: BodyInit | undefined;
  if (body instanceof Uint8Array) { b = body; hd['content-type'] ??= 'image/jpeg'; }
  else if (body !== undefined) { b = JSON.stringify(body); hd['content-type'] = 'application/json'; }
  return new Request(`${O}/api/collect/v1${path}`, { method, headers: hd, body: b });
}
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

const FIELDS = [
  { key: 'pic', label: 'Photo', type: 'photo', max_photos: 2, required: true },
  { key: 'kind', label: 'Kind', type: 'select', options: ['Plastic', 'Debris'], required: true },
  { key: 'size', label: 'Size (m)', type: 'number' },
  { key: 'note', label: 'Note', type: 'text' },
];

async function newMap(mode = 'form', moderation = 1) {
  const r = await j(await h.createCollection(env, req('POST', '/collections', '', {
    name: 'Garbage spots', purpose: 'Find them', license: 'CC-BY-4.0', moderation,
    schema_doc: { version: 1, geometry: ['point'], fields: FIELDS, mode },
  })));
  expect(r.status).toBe(200);
  return { id: r.body.id as string, edit: r.body.tokens.edit as string, admin: r.body.tokens.admin as string, view: r.body.tokens.view as string };
}
type M = Awaited<ReturnType<typeof newMap>>;

let n = 0;
const upload = async (m: M, meta: Record<string, unknown> = { lat: 12.97, lng: 77.59, taken_at: '2026-10-24T09:00:00+05:30', source: 'camera' }, clientId = `client-photo-${++n}-xxxxxxxx`, body = JPEG) =>
  j(await ph.uploadPhoto(env, req('POST', `/collections/${m.id}/photos`, m.edit, body, { 'x-client-id': clientId, 'x-photo-meta': JSON.stringify(meta) }), m.id));
const addPoint = async (m: M, props: Record<string, unknown>, token = m.edit) =>
  j(await h.addRecord(env, req('POST', `/collections/${m.id}/records`, token, { geometry: { type: 'Point', coordinates: [77.59, 12.97] }, properties: props }), m.id));
const getPhoto = (id: string, token = '') => ph.getPhoto(env, req('GET', `/photos/${id}`, token), id);
const listed = async (m: M, token = m.admin) => (await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records`, token), m.id))).body.features;
const rowOf = (id: string) => env.DB.raw.prepare('SELECT * FROM records WHERE id = ?').get(id) as Record<string, any>;

beforeEach(() => {
  objects = new Map();
  aiCalls = [];
  aiReply = JSON.stringify({ description: 'A heap of plastic bags by a wall.', tags: ['plastic', 'roadside'], answers: { kind: 'Plastic', size: 4, note: 'near the bus stop' } });
  const r2 = {
    async put(key: string, body: ArrayBuffer | Uint8Array | string) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body as ArrayBuffer);
      objects.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    async get(key: string) {
      const b = objects.get(key);
      return b ? { body: b, arrayBuffer: async () => b.slice().buffer, httpMetadata: { contentType: 'image/jpeg' } } : null;
    },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
  };
  env = {
    DB: sqliteD1(), R2: r2 as unknown as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub',
    AI: { run: async (model: string, input: unknown) => { aiCalls.push({ model, input }); return { choices: [{ message: { content: aiReply } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }; } } as unknown as Ai,
  } as TestEnv;
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('uploading a photo', () => {
  it('stores the JPEG in R2 under the map, with where and when it was taken', async () => {
    const m = await newMap();
    const r = await upload(m);
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^ph_/);
    const row = env.DB.raw.prepare('SELECT * FROM collect_photos WHERE id = ?').get(r.body.id) as Record<string, any>;
    expect(row).toMatchObject({ collection_id: m.id, record_id: null, lat: 12.97, lng: 77.59, source: 'camera', bytes: JPEG.byteLength });
    expect(row.taken_at).toBe('2026-10-24T03:30:00.000Z');
    expect(objects.get(row.r2_key)).toEqual(JPEG);
    expect(row.r2_key).toBe(`collect/${m.id}/photos/${r.body.id}.jpg`);
  });

  it('a repeated upload (lost reply) returns the same photo', async () => {
    const m = await newMap();
    const a = await upload(m, {}, 'same-client-photo-id-01');
    const b = await upload(m, {}, 'same-client-photo-id-01');
    expect(b.body.id).toBe(a.body.id);
    expect(objects.size).toBe(1);
  });

  it('needs the collect link, a JPEG, and a sensible size', async () => {
    const m = await newMap();
    expect((await j(await ph.uploadPhoto(env, req('POST', `/collections/${m.id}/photos`, m.view, JPEG, { 'x-client-id': 'client-photo-view-xxxx' }), m.id))).status).toBe(401);
    expect((await upload(m, {}, 'client-photo-png-xxxxx', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status).toBe(400);
    const big = new Uint8Array(ph.MAX_PHOTO_BYTES + 1); big.set(JPEG.slice(0, 3));
    expect((await upload(m, {}, 'client-photo-big-xxxxx', big)).status).toBe(413);
  });

  it('ignores a location outside India or nonsense metadata, keeping the photo', async () => {
    const m = await newMap();
    const r = await upload(m, { lat: 51.5, lng: -0.12, taken_at: 'yesterday', source: 'drone' });
    const row = env.DB.raw.prepare('SELECT * FROM collect_photos WHERE id = ?').get(r.body.id) as Record<string, any>;
    expect(row).toMatchObject({ lat: null, lng: null, taken_at: null, source: null });
  });
});

describe('photos on a point', () => {
  it('a point claims its photos; another point cannot take them', async () => {
    const m = await newMap();
    const p = (await upload(m)).body.id;
    const a = await addPoint(m, { pic: [p], kind: 'Plastic' });
    expect(a.status).toBe(200);
    expect((env.DB.raw.prepare('SELECT record_id FROM collect_photos WHERE id = ?').get(p) as any).record_id).toBe(a.body.id);
    const b = await addPoint(m, { pic: [p], kind: 'Plastic' });
    expect(b.status).toBe(400);
    expect(b.body.error).toMatch(/photo/i);
  });

  it('refuses a photo id from another map', async () => {
    const m1 = await newMap();
    const m2 = await newMap();
    const p = (await upload(m1)).body.id;
    expect((await addPoint(m2, { pic: [p], kind: 'Plastic' })).status).toBe(400);
  });

  it('is private until the point is approved, then public', async () => {
    const m = await newMap();
    const p = (await upload(m)).body.id;
    const a = await addPoint(m, { pic: [p], kind: 'Plastic' });
    expect(rowOf(a.body.id).status).toBe('pending');
    expect((await getPhoto(p)).status).toBe(401);
    expect((await getPhoto(p, m.view)).status).toBe(401);
    const asAdmin = await getPhoto(p, m.admin);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.headers.get('content-type')).toBe('image/jpeg');
    expect(asAdmin.headers.get('cache-control')).toMatch(/private/);
    expect((await getPhoto(p, a.body.edit_token)).status).toBe(200); // the contributor's own point
    await h.moderateRecord(env, req('POST', `/records/${a.body.id}/moderate`, m.admin, { status: 'published' }), a.body.id);
    const pub = await getPhoto(p);
    expect(pub.status).toBe(200);
    expect(pub.headers.get('cache-control')).toMatch(/public/);
    expect(new Uint8Array(await pub.arrayBuffer())).toEqual(JPEG);
  });

  it('deleting a point deletes its photos', async () => {
    const m = await newMap();
    const p = (await upload(m)).body.id;
    const a = await addPoint(m, { pic: [p], kind: 'Plastic' });
    await h.deleteRecordHandler(env, req('DELETE', `/records/${a.body.id}`, m.admin), a.body.id);
    expect(objects.size).toBe(0);
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM collect_photos').get()).toEqual({ n: 0 });
  });

  it('editing a point can swap a photo; the removed one is deleted', async () => {
    const m = await newMap();
    const p1 = (await upload(m)).body.id;
    const p2 = (await upload(m)).body.id;
    const a = await addPoint(m, { pic: [p1], kind: 'Plastic' });
    const e = await j(await h.editRecord(env, req('PATCH', `/records/${a.body.id}`, m.admin, { properties: { pic: [p2], kind: 'Plastic' } }), a.body.id));
    expect(e.status).toBe(200);
    expect(env.DB.raw.prepare('SELECT id FROM collect_photos').all()).toEqual([{ id: p2 }]);
  });

  it('unclaimed photos older than a day are cleared', async () => {
    const m = await newMap();
    const old = (await upload(m)).body.id;
    env.DB.raw.prepare('UPDATE collect_photos SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 86400_000).toISOString(), old);
    await ph.purgeOrphans(env, m.id);
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM collect_photos').get()).toEqual({ n: 0 });
    expect(objects.size).toBe(0);
  });

  it('lists photo links with each point', async () => {
    const m = await newMap('form', 0);
    const p = (await upload(m)).body.id;
    await addPoint(m, { pic: [p], kind: 'Plastic' });
    const [f] = await listed(m, m.view);
    expect(f.properties._photos).toEqual([{ field: 'pic', id: p, url: `${O}/api/collect/v1/photos/${p}` }]);
  });

  it('publishes photo links in place of the ids', async () => {
    const m = await newMap('form', 0);
    const p = (await upload(m)).body.id;
    await addPoint(m, { pic: [p], kind: 'Plastic' });
    const r = await j(await h.publish(env, req('POST', `/collections/${m.id}/publish`, m.admin), m.id));
    expect(r.status).toBe(200);
    const key = [...objects.keys()].find((k) => k.endsWith('.geojson'))!;
    const fc = JSON.parse(new TextDecoder().decode(objects.get(key)));
    expect(fc.features[0].properties.pic).toEqual([`${O}/api/collect/v1/photos/${p}`]);
  });
});

describe('just photos, the model fills the form', () => {
  it('takes a point with only its photo, always pending a person\'s check', async () => {
    const m = await newMap('photos_ai', 0);
    const p = (await upload(m)).body.id;
    const a = await addPoint(m, { pic: [p] });
    expect(a.status).toBe(200);
    expect(rowOf(a.body.id).status).toBe('pending');
  });

  it('cannot be approved until the required questions are answered', async () => {
    const m = await newMap('photos_ai', 0);
    const a = await addPoint(m, { pic: [(await upload(m)).body.id] });
    const r = await j(await h.moderateRecord(env, req('POST', `/records/${a.body.id}/moderate`, m.admin, { status: 'published' }), a.body.id));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Kind/);
  });
});

describe('notes from the photo', () => {
  async function aiPoint(mode = 'photos_ai') {
    const m = await newMap(mode, 0);
    const a = await addPoint(m, mode === 'photos_ai' ? { pic: [(await upload(m)).body.id] } : { pic: [(await upload(m)).body.id], kind: 'Debris' });
    return { m, id: a.body.id as string };
  }
  const notes = (id: string) => JSON.parse(rowOf(id).ai);

  it('runs the model on the photo after upload and keeps its notes apart', async () => {
    const { id } = await aiPoint();
    expect(aiCalls).toHaveLength(1);
    const call = aiCalls[0] as { model: string; input: any };
    expect(call.model).toBe(ai.AI_MODEL);
    const parts = call.input.messages[1].content;
    expect(parts.find((p: any) => p.type === 'image_url').image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    const n = notes(id);
    expect(n).toMatchObject({ status: 'done', model: ai.AI_MODEL, description: 'A heap of plastic bags by a wall.', tags: ['plastic', 'roadside'] });
    expect(n.answers).toEqual({ kind: 'Plastic', note: 'near the bus stop' }); // never a number
    expect(JSON.parse(rowOf(id).properties)).not.toHaveProperty('kind');
  });

  it('drops answers that are not among the choices', async () => {
    aiReply = JSON.stringify({ description: 'x', tags: [], answers: { kind: 'Glass' } });
    const { id } = await aiPoint();
    expect(notes(id).answers).toEqual({});
  });

  it('a map that fills in a form never calls the model', async () => {
    await aiPoint('form');
    expect(aiCalls).toHaveLength(0);
  });

  it('beyond the daily allowance, photos wait for the next day', async () => {
    env.AI_DAILY_PHOTOS = '1';
    await aiPoint();
    const second = await aiPoint();
    expect(aiCalls).toHaveLength(1);
    expect(notes(second.id)).toMatchObject({ status: 'waiting', reason: 'daily' });
  });

  it('a model failure is kept, and retried later', async () => {
    env.AI = { run: async () => { throw new Error('model down'); } } as unknown as Ai;
    const { m, id } = await aiPoint();
    expect(notes(id)).toMatchObject({ status: 'failed', tries: 1 });
    env.AI = { run: async () => ({ choices: [{ message: { content: aiReply } }] }) } as unknown as Ai;
    await ai.drainAi(env, m.id);
    expect(notes(id).status).toBe('done');
  });

  it('accepting fills only blank answers and can approve in one step', async () => {
    const { m, id } = await aiPoint();
    const r = await j(await ai.reviewAi(env, req('POST', `/records/${id}/ai`, m.admin, { action: 'accept', approve: true, description: 'Plastic bags piled by a wall.' }), id));
    expect(r.status).toBe(200);
    const row = rowOf(id);
    expect(row.status).toBe('published');
    expect(JSON.parse(row.properties)).toMatchObject({ kind: 'Plastic', note: 'near the bus stop' });
    expect(JSON.parse(row.ai)).toMatchObject({ review: 'accepted', description: 'Plastic bags piled by a wall.' });
  });

  it("never changes the collector's answers", async () => {
    const { m, id } = await aiPoint('form_ai');
    await ai.reviewAi(env, req('POST', `/records/${id}/ai`, m.admin, { action: 'accept' }), id);
    expect(JSON.parse(rowOf(id).properties).kind).toBe('Debris');
  });

  it('discarding keeps the point as the collector left it', async () => {
    const { m, id } = await aiPoint('form_ai');
    await ai.reviewAi(env, req('POST', `/records/${id}/ai`, m.admin, { action: 'discard' }), id);
    expect(notes(id).review).toBe('discarded');
    expect(JSON.parse(rowOf(id).properties)).not.toHaveProperty('note');
  });

  it('only the admin reviews notes; others see accepted notes only', async () => {
    const { m, id } = await aiPoint('form_ai');
    expect((await ai.reviewAi(env, req('POST', `/records/${id}/ai`, m.edit, { action: 'accept' }), id)).status).toBe(401);
    expect((await listed(m))[0].properties._ai.status).toBe('done');
    await h.moderateRecord(env, req('POST', `/records/${id}/moderate`, m.admin, { status: 'published' }), id);
    expect((await listed(m, m.view))[0].properties._ai).toBeNull();
    await ai.reviewAi(env, req('POST', `/records/${id}/ai`, m.admin, { action: 'accept' }), id);
    expect((await listed(m, m.view))[0].properties._ai).toEqual({ description: 'A heap of plastic bags by a wall.', tags: ['plastic', 'roadside'], model: ai.AI_MODEL });
  });

  it('accepted notes are published in their own columns', async () => {
    const { m, id } = await aiPoint('form_ai');
    await ai.reviewAi(env, req('POST', `/records/${id}/ai`, m.admin, { action: 'accept', approve: true }), id);
    await h.publish(env, req('POST', `/collections/${m.id}/publish`, m.admin), m.id);
    const key = [...objects.keys()].find((k) => k.endsWith('.geojson'))!;
    const props = JSON.parse(new TextDecoder().decode(objects.get(key))).features[0].properties;
    expect(props).toMatchObject({ photo_description: 'A heap of plastic bags by a wall.', photo_tags: 'plastic | roadside', photo_notes_model: ai.AI_MODEL });
  });
});
