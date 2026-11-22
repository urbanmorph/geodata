// Replacing a map's admin link: one admin call mints a new admin link and turns
// off every old one for that map in the same transaction. Anyone still holding
// an old admin link (another device, the MCP's saved token) gets a plain 401.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import { O, req, j, makeMap } from './helpers/api';
import { onRequest } from '../../functions/api/collect/[[path]]';
import type { Env } from '../../functions/types';

let env: Env & { DB: ReturnType<typeof sqliteD1> };


/** Through the real router, as a phone or the MCP would call it. */
const call = async (method: string, path: string, token = '', body?: unknown) =>
  j(await onRequest({
    request: req(method, path, token, body), env,
    params: { path: path.split('/').filter(Boolean).length ? ['v1', ...path.split('/').filter(Boolean)] : ['v1'] },
    waitUntil: () => {},
  } as unknown as Parameters<typeof onRequest>[0]));

const newMap = () => makeMap(env, { fields: [{ key: 'name', label: 'Name', type: 'text' }] });

beforeEach(() => {
  env = { DB: sqliteD1(), R2: {} as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' } as typeof env;
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
});

describe('replace the admin link', () => {
  it('gives a new admin link that works; the old one stops working', async () => {
    const m = await newMap();
    const r = await call('POST', `/collections/${m.id}/admin-link`, m.admin);
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^adm_/);
    expect(r.body.token).not.toBe(m.admin);
    expect(r.body.link).toBe(`${O}/c/${m.id}/admin#${r.body.token}`);
    expect((await call('GET', `/collections/${m.id}/tokens`, r.body.token)).status).toBe(200);
    expect((await call('GET', `/collections/${m.id}/tokens`, m.admin)).status).toBe(401);
  });

  it('turns off every older admin link of that map, and nothing else', async () => {
    const m = await newMap();
    const other = await newMap();
    const first = (await call('POST', `/collections/${m.id}/admin-link`, m.admin)).body.token;
    const second = (await call('POST', `/collections/${m.id}/admin-link`, first)).body.token;
    const active = env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM collection_tokens WHERE collection_id = ? AND permission = 'admin' AND is_active = 1`).get(m.id) as { n: number };
    expect(active.n).toBe(1);
    expect((await call('GET', `/collections/${m.id}/tokens`, second)).status).toBe(200);
    expect((await call('GET', `/collections/${m.id}`, m.edit)).status).toBe(200); // collect link untouched
    expect((await call('GET', `/collections/${other.id}/tokens`, other.admin)).status).toBe(200); // other map untouched
  });

  it('needs the admin link', async () => {
    const m = await newMap();
    expect((await call('POST', `/collections/${m.id}/admin-link`, m.edit)).status).toBe(401);
    expect((await call('POST', `/collections/${m.id}/admin-link`)).status).toBe(401);
    expect((await call('GET', `/collections/${m.id}/admin-link`, m.admin)).status).toBe(405);
  });

  it('tells someone holding a replaced or turned-off link why, in plain words', async () => {
    const m = await newMap();
    await call('POST', `/collections/${m.id}/admin-link`, m.admin);
    const stale = await call('GET', `/collections/${m.id}/records`, m.admin);
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe('this admin link was replaced or turned off');
    const wrong = await call('GET', `/collections/${m.id}/records`, 'adm_nottherightoneatallxxxxxxxxxxxxx');
    expect(wrong.body.error).toBe('unauthorised'); // an unknown token is not told anything more
  });
});
