// Keyring sync store (step 2): the server keeps one opaque, client-encrypted
// blob per keyring. It can't read it, and it can't tell whose it is. Writes need
// the write key (stored hashed); concurrent writes get a 409 so the client can
// merge; keyrings unused for 12 months are deleted.
import { describe, it, expect, beforeEach } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import * as h from '../../functions/lib/handlers';
import type { Env } from '../../functions/types';

const ID = 'a'.repeat(32);
const KEY = 'W'.repeat(43);
let env: Env;

function req(method: string, token = '', body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`https://collect.test/api/collect/v1/keyrings/${ID}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });
const put = (blob: string, base: string | null, key = KEY, id = ID) => h.putKeyring(env, req('PUT', key, { blob, base }), id);

beforeEach(() => { env = { DB: sqliteD1(), R2: {} as R2Bucket }; });

describe('keyring store', () => {
  it('creates on first write, then reads back the same blob', async () => {
    const w = await j(await put('c2VhbGVk', null));
    expect(w.status).toBe(200);
    expect(typeof w.body.updated_at).toBe('string');
    const r = await j(await h.getKeyring(env, req('GET'), ID));
    expect(r).toEqual({ status: 200, body: { blob: 'c2VhbGVk', updated_at: w.body.updated_at } });
  });

  it('404s for a keyring that does not exist', async () => {
    expect((await h.getKeyring(env, req('GET'), ID)).status).toBe(404);
  });

  it('needs the same write key to update or delete', async () => {
    const first = (await j(await put('b25l', null))).body.updated_at;
    expect((await put('dHdv', first, 'X'.repeat(43))).status).toBe(401);
    expect((await h.deleteKeyring(env, req('DELETE', 'X'.repeat(43)), ID)).status).toBe(401);
    expect((await put('dHdv', first)).status).toBe(200);
  });

  it('refuses a stale write with 409 and returns the current blob to merge', async () => {
    const v1 = (await j(await put('djE', null))).body.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    const v2 = (await j(await put('djI', v1))).body.updated_at;
    const stale = await j(await put('djM', v1)); // another device still on v1
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ blob: 'djI', updated_at: v2 });
  });

  it('a create racing an existing keyring is a conflict, not an overwrite', async () => {
    await put('b25l', null);
    expect((await put('dHdv', null)).status).toBe(409);
  });

  it('deletes with the write key ("turn off sync")', async () => {
    await put('b25l', null);
    expect((await h.deleteKeyring(env, req('DELETE', KEY), ID)).status).toBe(200);
    expect((await h.getKeyring(env, req('GET'), ID)).status).toBe(404);
  });

  it('validates id, key and blob', async () => {
    expect((await put('b25l', null, KEY, 'not-hex')).status).toBe(400);
    expect((await put('b25l', null, 'short')).status).toBe(401);
    expect((await put('not base64url!', null)).status).toBe(400);
    expect((await put('A'.repeat(300_000), null)).status).toBe(413);
  });

  it('deletes keyrings unused for 12 months when anyone writes', async () => {
    const old = 'b'.repeat(32);
    await put('b2xk', null, KEY, old);
    const longAgo = new Date(Date.now() - 366 * 86_400_000).toISOString();
    (env.DB as any).raw.prepare('UPDATE collect_keyrings SET used_at = ? WHERE id = ?').run(longAgo, old);
    await put('bmV3', null);
    expect((await h.getKeyring(env, req('GET'), old)).status).toBe(404);
    expect((await h.getKeyring(env, req('GET'), ID)).status).toBe(200);
  });

  it('a read counts as use, so a keyring that is only read is kept', async () => {
    await put('b25l', null);
    const longAgo = new Date(Date.now() - 366 * 86_400_000).toISOString();
    (env.DB as any).raw.prepare('UPDATE collect_keyrings SET used_at = ?').run(longAgo);
    await h.getKeyring(env, req('GET'), ID);
    await put('bmV3', null, KEY, 'c'.repeat(32)); // triggers the purge
    expect((await h.getKeyring(env, req('GET'), ID)).status).toBe(200);
  });

  it('a device writing against a deleted keyring gets 410, so it stops syncing instead of re-creating it', async () => {
    const v1 = (await j(await put('b25l', null))).body.updated_at;
    await h.deleteKeyring(env, req('DELETE', KEY), ID);
    expect((await put('dHdv', v1)).status).toBe(410);
    expect((await h.getKeyring(env, req('GET'), ID)).status).toBe(404);
  });
});
