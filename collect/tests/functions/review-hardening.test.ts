// Server fixes from the Nov 2026 collect review: bounded free text, photos
// cleaned of camera details on the server too, an all-or-nothing map create, a
// keyring create race answered as a conflict, only known schema settings kept,
// the current basemap ids, a geometry-only record list for the capture map, and
// publish refusing (not truncating) a map too large to publish at once.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import { O, req, j, createMap, makeMap } from './helpers/api';
import * as h from '../../functions/lib/handlers';
import * as ph from '../../functions/lib/photos';
import { readExif } from '../../src/photos/exif';
import { validateSchemaDoc } from '../../src/schema/validate-collection';
import type { Env } from '../../functions/types';

type TestEnv = Env & { DB: ReturnType<typeof sqliteD1> };
let env: TestEnv;
let objects: Map<string, Uint8Array>;


const NAME = [{ key: 'name', label: 'Name', type: 'text' }];
const create = (extra: Record<string, unknown> = {}, schema: Record<string, unknown> = {}) =>
  createMap(env, { moderation: 0, fields: NAME, schema, extra });
const newMap = (schema: Record<string, unknown> = {}) => makeMap(env, { moderation: 0, fields: NAME, schema });
const point = { type: 'Point', coordinates: [77.59, 12.97] };
const add = async (m: { id: string; edit: string }, body: Record<string, unknown>) =>
  j(await h.addRecord(env, req('POST', `/collections/${m.id}/records`, m.edit, { geometry: point, properties: { name: 'Neem' }, ...body }), m.id));

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
});

describe('free text has a length limit', () => {
  it('a contributor name over 120 characters is refused; one at the limit is kept', async () => {
    const m = await newMap();
    expect((await add(m, { contributor: 'x'.repeat(121) })).status).toBe(400);
    expect((await add(m, { contributor: 'x'.repeat(120) })).status).toBe(200);
  });
  it('an import names its contributor within the same limit', async () => {
    const m = await newMap();
    const r = await j(await h.importRecords(env, req('POST', `/collections/${m.id}/import`, m.admin, {
      records: [{ geometry: point, properties: { name: 'a' } }], source: 'Survey', rights_confirmed: true, contributor: 'y'.repeat(121),
    }), m.id));
    expect(r.status).toBe(400);
  });
  it('a rejection reason over 500 characters is refused', async () => {
    const m = await newMap();
    const rec = await add(m, {});
    const mod = (reason: string) => h.moderateRecord(env, req('POST', `/records/${rec.body.id}/moderate`, m.admin, { status: 'rejected', reason }), rec.body.id);
    expect((await mod('r'.repeat(501))).status).toBe(400);
    expect((await mod('Not a tree')).status).toBe(200);
  });
  it('a new map description over 2000 characters is refused, as on edit', async () => {
    expect((await create({ description: 'd'.repeat(2001) })).status).toBe(400);
  });
});

describe('photos keep only where and when, whatever the phone sent', () => {
  // A JPEG with an EXIF block holding a camera "Make" (PhoneCo) and a time.
  const make = [...'PhoneCo'].map((c) => c.charCodeAt(0)).concat(0);
  const time = [...'2026:10:24 09:15:00'].map((c) => c.charCodeAt(0)).concat(0); // 20 bytes
  // IFD0 (at 8): 2 entries (Make, ExifIFD pointer); Exif IFD (at 38): DateTimeOriginal.
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0,
    2, 0, 0x0f, 0x01, 2, 0, 8, 0, 0, 0, 56, 0, 0, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0,
    1, 0, 0x03, 0x90, 2, 0, 20, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0,
    ...make, ...time,
  ];
  const app1 = [0xff, 0xe1, (tiff.length + 8) >> 8, (tiff.length + 8) & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const JPEG = new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9]);

  it('removes camera details from an upload and keeps the time', async () => {
    expect(new TextDecoder().decode(JPEG)).toContain('PhoneCo');
    expect(readExif(JPEG).takenAt).toBe('2026-10-24T09:15:00');
    const m = await newMap();
    const r = await j(await ph.uploadPhoto(env, req('POST', `/collections/${m.id}/photos`, m.edit, JPEG, { 'x-client-id': 'client-photo-1-xxxxxxxx' }), m.id));
    expect(r.status).toBe(200);
    const [stored] = [...objects.values()];
    expect(new TextDecoder().decode(stored)).not.toContain('PhoneCo');
    expect(readExif(stored).takenAt).toBe('2026-10-24T09:15:00');
  });
});

describe('a new map is created whole or not at all', () => {
  it('leaves no map behind when one of its links fails to save', async () => {
    env.DB.raw.exec(`CREATE TRIGGER fail_view BEFORE INSERT ON collection_tokens WHEN NEW.permission = 'view'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    await expect(create()).rejects.toThrow();
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM collections').get()).toEqual({ n: 0 });
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM collection_tokens').get()).toEqual({ n: 0 });
  });
});

describe('keyring: two first writes at once', () => {
  it('the second is a conflict carrying the first, not a server error', async () => {
    const ID = 'b'.repeat(32), KEY = 'K'.repeat(43);
    const put = (blob: string) => h.putKeyring(env, new Request(`${O}/api/collect/v1/keyrings/${ID}`, {
      method: 'PUT', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ blob, base: null }),
    }), ID);
    expect((await put('Zmlyc3Q')).status).toBe(200);
    // The second write read "no keyring yet" just before the first one landed.
    const prepare = env.DB.prepare.bind(env.DB);
    let raced = false;
    env.DB.prepare = ((sql: string) => {
      if (!raced && /FROM collect_keyrings WHERE id/.test(sql)) { raced = true; return { bind: () => ({ first: async () => null }) }; }
      return prepare(sql);
    }) as typeof env.DB.prepare;
    const r = await j(await put('c2Vjb25k'));
    expect(r.status).toBe(409);
    expect(r.body.blob).toBe('Zmlyc3Q');
  });
});

describe('schema settings', () => {
  it('keeps only known settings, and only id + pmtiles_url of a reference layer', async () => {
    const m = await newMap({ evil: 'x'.repeat(1000), reference_layer: { id: 'wards_x', pmtiles_url: 'https://r2.dev/x.pmtiles', extra: 1 } });
    const meta = await j(await h.getCollectionMeta(env, req('GET', `/collections/${m.id}`, m.edit), m.id));
    expect(meta.body.schema.evil).toBeUndefined();
    expect(meta.body.schema.reference_layer).toEqual({ id: 'wards_x', pmtiles_url: 'https://r2.dev/x.pmtiles' });
  });
  it("accepts today's basemap ids and the retired ones stored maps may carry", async () => {
    const doc = (basemap: string) => ({ version: 1, geometry: ['point'], fields: [], basemap });
    for (const b of ['liberty', 'osm', 'opentopo', 'satellite', 'positron', 'topo']) expect(validateSchemaDoc(doc(b)).ok).toBe(true);
    expect(validateSchemaDoc(doc('nope')).ok).toBe(false);
    expect((await create({}, { basemap: 'liberty' })).status).toBe(200);
  });
});

describe('the capture map asks for shapes only', () => {
  it('fields=geometry lists each record with its geometry and no answers', async () => {
    const m = await newMap();
    await add(m, { contributor: 'Asha' });
    const r = await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records?fields=geometry`, m.edit), m.id));
    expect(r.status).toBe(200);
    expect(r.body.features).toHaveLength(1);
    expect(r.body.features[0]).toEqual({ type: 'Feature', id: expect.any(String), geometry: point, properties: {} });
  });
});

describe('publish', () => {
  it('refuses a map with more approved points than it can publish at once, instead of cutting it short', async () => {
    const m = await newMap();
    const ins = env.DB.raw.prepare(`INSERT INTO records (id, collection_id, created_at, status, geometry, properties, edit_token_hash, ip_hash)
      VALUES (?, ?, '2026-10-01T00:00:00.000Z', 'published', ?, '{}', 'x', 'ip')`);
    env.DB.raw.exec('BEGIN');
    for (let i = 0; i <= h.PUBLISH_MAX_POINTS; i++) ins.run(`r${i}`, m.id, JSON.stringify(point));
    env.DB.raw.exec('COMMIT');
    const r = await j(await h.publish(env, req('POST', `/collections/${m.id}/publish`, m.admin), m.id));
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/too many/i);
  });
});
