import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sqliteD1 } from '../../collect/tests/functions/helpers/sqlite-d1';
import { onRequestPost, validateRequest } from '../functions/api/request-layer';

// POST /api/request-layer: a layer request is saved with a reference, or refused with nothing kept. The
// requester's email is stored for the owner's reply and never sent back; nothing is paid here.

const good = {
  what: 'Anganwadi centres in Pune with their ward', place: 'Pune', source: 'https://example.org/anganwadi',
  name: 'Asha R.', email: 'asha@example.org', q: 'anganwadi pune', turnstile_token: 'tok',
};

async function call(body: unknown, db: D1Database, turnstileOk = true) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: turnstileOk }))));
  const request = new Request('https://bharatlas.com/api/request-layer', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
  });
  const res = await onRequestPost({ request, env: { DB: db, TURNSTILE_SECRET: 's' }, waitUntil: () => {} } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const rows = (db: D1Database) =>
  db.prepare('SELECT * FROM layer_requests').all().then((r) => r.results as Record<string, unknown>[]);

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('/api/request-layer', () => {
  it('saves a request with a reference and status new, and never echoes the email', async () => {
    const db = sqliteD1();
    const { status, body } = await call(good, db);
    expect(status).toBe(201);
    expect(body.reference).toMatch(/^req_[A-Za-z0-9_-]{10}$/);
    expect(JSON.stringify(body)).not.toContain('asha@example.org');
    const [r] = await rows(db);
    expect(r).toMatchObject({ id: body.reference, what: good.what, place: 'Pune', credit_name: 'Asha R.',
      email: 'asha@example.org', query: 'anganwadi pune', status: 'new' });
    expect(String(r.ip_hash)).not.toContain('203.0.113.9');
  });

  it('refuses a failed Turnstile check and keeps nothing', async () => {
    const db = sqliteD1();
    expect((await call(good, db, false)).status).toBe(403);
    expect(await rows(db)).toEqual([]);
  });

  it('refuses a request without what or a valid email, naming the field, and keeps nothing', async () => {
    const db = sqliteD1();
    const r1 = await call({ ...good, what: '' }, db);
    const r2 = await call({ ...good, email: 'not-an-email' }, db);
    expect([r1.status, r2.status]).toEqual([400, 400]);
    expect(r1.body.field).toBe('what');
    expect(r2.body.field).toBe('email');
    expect(await rows(db)).toEqual([]);
  });

  it('allows an anonymous request (no name), and a request with no source', async () => {
    const db = sqliteD1();
    expect((await call({ ...good, name: '', source: '' }, db)).status).toBe(201);
    expect((await rows(db))[0]).toMatchObject({ credit_name: '', source: '' });
  });
});

describe('validateRequest', () => {
  it('trims fields and caps their length', () => {
    const v = validateRequest({ ...good, what: '  x'.repeat(5) + 'roads  ', name: ' A ' });
    expect(v.ok && v.value.credit_name).toBe('A');
    const long = validateRequest({ ...good, what: 'x'.repeat(2001) });
    expect(long.ok).toBe(false);
  });
});
