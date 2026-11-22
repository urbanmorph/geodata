// Labelled links (step 4): an admin can mint a named collect/view link, see
// which link added each record, list links with their record counts, and turn
// one off without changing anyone else's. All additive: existing calls and
// responses keep working unchanged (the bharatlas MCP depends on them).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import { O, req, j, makeMap } from './helpers/api';
import * as h from '../../functions/lib/handlers';
import type { Env } from '../../functions/types';

let env: Env;


const newMap = () => makeMap(env, { moderation: 0 });
const point = { type: 'Point', coordinates: [77.59, 12.97] };
const add = (id: string, token: string, name: string) =>
  h.addRecord(env, req('POST', `/collections/${id}/records`, token, { geometry: point, properties: { name } }), id);

beforeEach(() => {
  env = { DB: sqliteD1(), R2: {} as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' };
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 })); // no network in tests
});

describe('mint a labelled link', () => {
  it('returns the existing fields plus id and label', async () => {
    const m = await newMap();
    const r = await j(await h.mintToken(env, req('POST', `/collections/${m.id}/tokens`, m.admin, { permission: 'edit', label: '  Ward 12 team ' }), m.id));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ permission: 'edit', label: 'Ward 12 team' });
    expect(r.body.token).toMatch(/^edt_/);
    expect(r.body.link).toBe(`${O}/c/${m.id}#${r.body.token}`);
    expect(typeof r.body.id).toBe('string');
  });
  it('still works with no label (label null)', async () => {
    const m = await newMap();
    const r = await j(await h.mintToken(env, req('POST', `/collections/${m.id}/tokens`, m.admin, { permission: 'view' }), m.id));
    expect(r.status).toBe(200);
    expect(r.body.label).toBeNull();
  });
  it('rejects a label that is too long or not text', async () => {
    const m = await newMap();
    for (const label of ['x'.repeat(61), 42]) {
      const r = await h.mintToken(env, req('POST', `/collections/${m.id}/tokens`, m.admin, { permission: 'edit', label }), m.id);
      expect(r.status).toBe(400);
    }
  });
});

describe('which link added a record', () => {
  it('admin sees the link id and label on each record; others do not', async () => {
    const m = await newMap();
    const minted = (await j(await h.mintToken(env, req('POST', `/collections/${m.id}/tokens`, m.admin, { permission: 'edit', label: 'Asha' }), m.id))).body;
    expect((await add(m.id, minted.token, 'Neem')).status).toBe(200);
    expect((await add(m.id, m.edit, 'Peepal')).status).toBe(200);

    const asAdmin = (await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records`, m.admin), m.id))).body.features;
    const byName = Object.fromEntries(asAdmin.map((f: any) => [f.properties.name, f.properties]));
    expect(byName.Neem).toMatchObject({ _link_id: minted.id, _link_label: 'Asha' });
    expect(byName.Peepal._link_label).toBeNull(); // the unlabelled original collect link
    expect(typeof byName.Peepal._link_id).toBe('string');

    const asCollector = (await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records`, m.edit), m.id))).body.features;
    expect(asCollector).toHaveLength(2);
    for (const f of asCollector) {
      expect(f.properties).not.toHaveProperty('_link_id');
      expect(f.properties).not.toHaveProperty('_link_label');
    }
  });
});

describe('list links', () => {
  it('admin gets id, permission, label, active, created_at and record count, never the token', async () => {
    const m = await newMap();
    const minted = (await j(await h.mintToken(env, req('POST', `/collections/${m.id}/tokens`, m.admin, { permission: 'edit', label: 'Asha' }), m.id))).body;
    await add(m.id, minted.token, 'a');
    await add(m.id, minted.token, 'b');
    const r = await j(await h.listTokens(env, req('GET', `/collections/${m.id}/tokens`, m.admin), m.id));
    expect(r.status).toBe(200);
    const asha = r.body.links.find((l: any) => l.id === minted.id);
    expect(asha).toEqual({ id: minted.id, permission: 'edit', label: 'Asha', active: true, created_at: expect.any(String), records: 2 });
    expect(r.body.links.map((l: any) => l.permission).sort()).toEqual(['admin', 'edit', 'edit', 'view']);
    expect(JSON.stringify(r.body)).not.toMatch(/edt_|adm_|vw_|token_hash/);
  });
  it('is admin-only', async () => {
    const m = await newMap();
    expect((await h.listTokens(env, req('GET', `/collections/${m.id}/tokens`, m.edit), m.id)).status).toBe(401);
  });
  it('a view link adding a point is told why, in plain words', async () => {
    const m = await newMap();
    const view = (await j(await h.mintToken(env, req('POST', `/collections/${m.id}/tokens`, m.admin, { permission: 'view' }), m.id))).body.token;
    const r = await j(await add(m.id, view, 'x'));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/edit or admin link/);
    expect(r.body.error).not.toMatch(/—/);
  });
});

describe('revoke one link', () => {
  it('turns that link off; its records stay; other links keep working', async () => {
    const m = await newMap();
    const minted = (await j(await h.mintToken(env, req('POST', `/collections/${m.id}/tokens`, m.admin, { permission: 'edit', label: 'Asha' }), m.id))).body;
    await add(m.id, minted.token, 'kept');
    const r = await h.revokeToken(env, req('DELETE', `/collections/${m.id}/tokens/${minted.id}`, m.admin), m.id, minted.id);
    expect(r.status).toBe(200);
    expect((await add(m.id, minted.token, 'blocked')).status).toBe(401);
    expect((await add(m.id, m.edit, 'still fine')).status).toBe(200);
    const names = (await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records`, m.admin), m.id))).body.features.map((f: any) => f.properties.name);
    expect(names.sort()).toEqual(['kept', 'still fine']);
    const links = (await j(await h.listTokens(env, req('GET', `/collections/${m.id}/tokens`, m.admin), m.id))).body.links;
    expect(links.find((l: any) => l.id === minted.id).active).toBe(false);
  });
  it('refuses to revoke an admin link (no lock-out), from a non-admin, or across maps', async () => {
    const m = await newMap();
    const other = await newMap();
    const links = (await j(await h.listTokens(env, req('GET', `/collections/${m.id}/tokens`, m.admin), m.id))).body.links;
    const adminId = links.find((l: any) => l.permission === 'admin').id;
    const editId = links.find((l: any) => l.permission === 'edit').id;
    expect((await h.revokeToken(env, req('DELETE', `/x`, m.admin), m.id, adminId)).status).toBe(400);
    expect((await h.revokeToken(env, req('DELETE', `/x`, m.edit), m.id, editId)).status).toBe(401);
    expect((await h.revokeToken(env, req('DELETE', `/x`, other.admin), other.id, editId)).status).toBe(404);
    expect((await h.revokeToken(env, req('DELETE', `/x`, m.admin), m.id, 'nope')).status).toBe(404);
  });
});

describe('reuse an unnamed link instead of minting one per Share visit', () => {
  const mint = async (id: string, admin: string, body: unknown) =>
    j(await h.mintToken(env, req('POST', `/collections/${id}/tokens`, admin, body), id));
  const count = async (id: string, admin: string) =>
    (await j(await h.listTokens(env, req('GET', `/collections/${id}/tokens`, admin), id))).body.links.length;

  it('hands back the active link the admin already holds, adding none', async () => {
    const m = await newMap();
    const before = await count(m.id, m.admin);
    const r = await mint(m.id, m.admin, { permission: 'edit', reuse: m.edit });
    expect(r.status).toBe(200);
    expect(r.body.token).toBe(m.edit);
    expect(r.body.link).toBe(`${O}/c/${m.id}#${m.edit}`);
    expect(await count(m.id, m.admin)).toBe(before);
  });
  it('mints a fresh one when the held link is off, of another permission, named, or from another map', async () => {
    const m = await newMap();
    const other = await newMap();
    const named = (await mint(m.id, m.admin, { permission: 'edit', label: 'Asha' })).body;
    const editId = (await j(await h.listTokens(env, req('GET', `/x`, m.admin), m.id))).body.links.find((l: any) => l.permission === 'edit' && !l.label).id;
    await h.revokeToken(env, req('DELETE', `/x`, m.admin), m.id, editId);
    for (const [permission, reuse] of [['edit', m.edit], ['view', m.edit], ['edit', named.token], ['edit', other.edit], ['edit', 42]]) {
      const r = await mint(m.id, m.admin, { permission, reuse });
      expect(r.status).toBe(200);
      expect(r.body.token).not.toBe(reuse);
    }
  });
});

describe('backward compatible', () => {
  it('create still returns id, links and tokens', async () => {
    const r = await j(await h.createCollection(env, req('POST', '/collections', '', {
      name: 'Old client', purpose: 'p', license: 'CC0-1.0',
      schema_doc: { version: 1, geometry: ['point'], fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    })));
    expect(Object.keys(r.body).sort()).toEqual(['id', 'links', 'tokens']);
  });
  it('records written before this change (no token_id) still list for admin with null link fields', async () => {
    const m = await newMap();
    await add(m.id, m.edit, 'legacy');
    await (env.DB as any).raw.exec(`UPDATE records SET token_id = NULL`);
    const f = (await j(await h.listRecords(env, req('GET', `/collections/${m.id}/records`, m.admin), m.id))).body.features[0];
    expect(f.properties).toMatchObject({ name: 'legacy', _link_id: null, _link_label: null });
  });
});
