// The admin gate every admin call starts with: 401 for anything but the map's
// admin link, 404 for a map that is gone, else the map itself.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import { req, makeMap } from './helpers/api';
import { adminMap, isAdmin } from '../../functions/lib/auth';
import type { Env } from '../../functions/types';

let env: Env & { DB: ReturnType<typeof sqliteD1> };

beforeEach(() => {
  env = { DB: sqliteD1(), R2: {} as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' } as typeof env;
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
});

const body = async (r: unknown) => (r instanceof Response ? { status: r.status, body: await r.json() } : null);

describe('adminMap', () => {
  it('returns the map for its admin link', async () => {
    const m = await makeMap(env);
    const c = await adminMap(env, req('GET', '/', m.admin), m.id);
    expect(c).not.toBeInstanceOf(Response);
    expect((c as { id: string }).id).toBe(m.id);
  });

  it('refuses an edit link and no link with a bare 401', async () => {
    const m = await makeMap(env);
    expect(await body(await adminMap(env, req('GET', '/', m.edit), m.id))).toEqual({ status: 401, body: { error: 'unauthorised' } });
    expect(await body(await adminMap(env, req('GET', '/'), m.id))).toEqual({ status: 401, body: { error: 'unauthorised' } });
  });

  it('answers 404 when the map is gone', async () => {
    const m = await makeMap(env);
    // A map row gone while its links remain (foreign keys cascade otherwise).
    env.DB.raw.exec('PRAGMA foreign_keys = OFF');
    await env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(m.id).run();
    expect(await body(await adminMap(env, req('GET', '/', m.admin), m.id))).toEqual({ status: 404, body: { error: 'not found' } });
  });

  it('hands the gate name to a logging refuse', async () => {
    const m = await makeMap(env);
    const gates: string[] = [];
    const refuse = (status: number, gate: string, error: string) => { gates.push(gate); return new Response(error, { status }); };
    expect(((await adminMap(env, req('GET', '/', m.edit), m.id, refuse)) as Response).status).toBe(401);
    expect(gates).toEqual(['auth']);
  });
});

describe('isAdmin', () => {
  it('is true only for the admin link', async () => {
    const m = await makeMap(env);
    expect(await isAdmin(env, req('GET', '/', m.admin), m.id)).toBe(true);
    expect(await isAdmin(env, req('GET', '/', m.edit), m.id)).toBe(false);
    expect(await isAdmin(env, req('GET', '/', m.view), m.id)).toBe(false);
  });
});
