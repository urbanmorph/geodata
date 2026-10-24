// Publishing a map to the catalog stores everything (GeoJSON + contributors
// file in R2; submission, admin token, collection link and publication rows in
// D1) or nothing, and every outcome is logged with a reference. The old code
// wrote six things one after another with no rollback and no failure log.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sqliteD1 } from './helpers/sqlite-d1';
import * as h from '../../functions/lib/handlers';
import type { Env } from '../../functions/types';

const O = 'https://collect.test';
let env: Env & { DB: ReturnType<typeof sqliteD1> };
let objects: Map<string, number>;
let failPut = false;
let pending: Promise<unknown>[];
const defer = (p: Promise<unknown>) => { pending.push(p); };

function req(method: string, path: string, token = '', body?: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`${O}/api/collect/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });
const n = async (table: string) => ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()) as { n: number }).n;

async function mapWithAPoint(): Promise<{ id: string; admin: string }> {
  const c = await j(await h.createCollection(env, req('POST', '/collections', '', {
    name: 'Ward trees', purpose: 'Street trees', license: 'CC-BY-4.0',
    schema_doc: { version: 1, geometry: ['point'], fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] },
    moderation: 0,
  })));
  expect(c.status).toBe(200);
  const add = await h.addRecord(env, req('POST', `/collections/${c.body.id}/records`, c.body.tokens.edit,
    { geometry: { type: 'Point', coordinates: [77.59, 12.97] }, properties: { name: 'Neem' } }), c.body.id);
  expect(add.status).toBe(200);
  return { id: c.body.id, admin: c.body.tokens.admin };
}
async function publish(m: { id: string; admin: string }) {
  const r = await j(await h.publish(env, req('POST', `/collections/${m.id}/publish`, m.admin, {}), m.id, defer));
  await Promise.all(pending);
  return r;
}
const publishAttempts = async () =>
  ((await env.DB.prepare(`SELECT * FROM collect_attempts WHERE event = 'publish'`).all()).results as Record<string, unknown>[]);

beforeEach(() => {
  objects = new Map();
  failPut = false;
  pending = [];
  const r2 = {
    async put(key: string, body: ArrayBuffer | string) {
      if (failPut) throw new Error('R2 put failed: network connection lost');
      const size = typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;
      objects.set(key, size);
      return { key, size };
    },
    async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
  };
  env = { DB: sqliteD1(), R2: r2 as unknown as R2Bucket, LOCATE_ORIGIN: 'http://locate.stub' } as typeof env;
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 })); // no network in tests
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('publish', () => {
  it('stores both files and all four rows, and logs the attempt with its reference', async () => {
    const m = await mapWithAPoint();
    const r = await publish(m);
    expect(r.status).toBe(200);
    expect(r.body.attempt_id).toMatch(/^att_/);
    expect(objects.size).toBe(2);
    expect(await n('submissions')).toBe(1);
    expect(await n('submission_tokens')).toBe(1);
    expect(await n('publications')).toBe(1);
    const sub = await env.DB.prepare('SELECT collection_id, collection_version FROM submissions').first();
    expect(sub).toEqual({ collection_id: m.id, collection_version: 1 });
    expect((await publishAttempts())[0]).toMatchObject({ outcome: 'ok', attempt_id: r.body.attempt_id, submission_id: r.body.submission_id });
  });

  it('keeps nothing when a file cannot be stored, and logs why', async () => {
    const m = await mapWithAPoint();
    failPut = true;
    const r = await publish(m);
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/nothing was kept/i);
    expect(await n('submissions')).toBe(0);
    expect(await n('publications')).toBe(0);
    expect((await publishAttempts())[0]).toMatchObject({ outcome: 'rejected', gate: 'persist', step: 'store_file', attempt_id: r.body.attempt_id });
  });

  it('keeps nothing when a row cannot be written (files deleted), and logs why', async () => {
    const m = await mapWithAPoint();
    // Only the save step touches submission_tokens (publish reads publications earlier).
    env.DB.raw.exec('DROP TABLE submission_tokens');
    const r = await publish(m);
    expect(r.status).toBe(500);
    expect(objects.size).toBe(0);
    expect(await n('submissions')).toBe(0);
    const [a] = await publishAttempts();
    expect(a).toMatchObject({ gate: 'persist', step: 'write_rows', cleanup: 'deleted 2 file(s)' });
    expect(String(a.detail)).toMatch(/submission_tokens/);
    expect(await n('publications')).toBe(0);
  });
});
