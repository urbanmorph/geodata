import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sqliteD1 } from '../../collect/tests/functions/helpers/sqlite-d1';
import { onRequestPost } from '../functions/api/submit';

// End to end through the real /api/submit handler, against the real schema.
// A contributor's submission is saved completely or not at all, every attempt
// (success, failure, malformed request, crash) is logged with a reference the
// contributor sees, and a failure tells them plainly that nothing was kept.

function fakeR2(opts: { failPut?: boolean; failDelete?: boolean } = {}) {
  const objects = new Map<string, number>();
  return {
    objects,
    async put(key: string, body: ArrayBuffer | string) {
      if (opts.failPut) throw new Error('R2 put failed: network connection lost');
      const size = typeof body === 'string' ? body.length : body.byteLength;
      objects.set(key, size);
      return { key, size };
    },
    async delete(keys: string | string[]) {
      if (opts.failDelete) throw new Error('R2 delete failed');
      for (const k of [keys].flat()) objects.delete(k);
    },
  };
}

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [78.13, 20.39] }, properties: { name: 'Yavatmal bus stand' } }],
});

function form(extra: Record<string, string> = {}, fileOverride?: File | null) {
  const fd = new FormData();
  if (fileOverride !== null) fd.set('file', fileOverride ?? new File([GEOJSON], 'yavatmal_bus_stands.geojson'));
  const fields = {
    turnstile_token: 'tok', name: 'Yavatmal bus stands', category: 'transport', license: 'CC0-1.0',
    attribution: 'Field survey', source_url: 'https://example.org/yavatmal', ...extra,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function call(body: BodyInit, env: { DB: D1Database; R2: unknown }) {
  const pending: Promise<unknown>[] = [];
  const request = new Request('https://bharatlas.com/api/submit', {
    method: 'POST', body, headers: { 'cf-connecting-ip': '203.0.113.7' },
  });
  const ctx = { request, env: { ...env, TURNSTILE_SECRET: 's' }, waitUntil: (p: Promise<unknown>) => pending.push(p) };
  const res = await onRequestPost(ctx as never);
  await Promise.all(pending); // let the attempt log land
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const attempts = (db: D1Database) =>
  db.prepare('SELECT * FROM submit_attempts ORDER BY id').all().then((r) => r.results as Record<string, unknown>[]);
const count = (db: D1Database, table: string) =>
  db.prepare(`SELECT COUNT(*) n FROM ${table}`).first().then((r) => (r as { n: number }).n);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }))));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('/api/submit: reading the FeatureCollection', () => {
  const kml = () => new File(['<kml/>'], 'stands.kml');

  it("a non-GeoJSON upload is read from the browser's fc_json", async () => {
    const fd = form({}, kml());
    fd.set('fc_json', GEOJSON);
    const { status } = await call(fd, { DB: sqliteD1(), R2: fakeR2() });
    expect(status).toBe(200);
  });

  it('a non-GeoJSON upload without fc_json is a 400, logged as a parse failure', async () => {
    const db = sqliteD1();
    const { status, body } = await call(form({}, kml()), { DB: db, R2: fakeR2() });
    expect(status).toBe(400);
    expect(body.error).toBe('missing fc_json for non-GeoJSON upload');
    expect((await attempts(db))[0]).toMatchObject({ outcome: 'rejected', gate: 'parse', reason: 'missing fc_json for non-GeoJSON upload' });
  });

  it.each([
    ['GeoJSON that is not JSON', () => form({}, new File(['{not json'], 'x.geojson'))],
    ['an fc_json that is not JSON', () => { const fd = form({}, kml()); fd.set('fc_json', '{nope'); return fd; }],
  ])('%s is a 400 parse failure with the detail logged', async (_n, make) => {
    const db = sqliteD1();
    const { status, body } = await call(make(), { DB: db, R2: fakeR2() });
    expect(status).toBe(400);
    expect(body.error).toBe('failed to parse FeatureCollection');
    const [a] = await attempts(db);
    expect(a).toMatchObject({ outcome: 'rejected', gate: 'parse', reason: 'failed to parse FeatureCollection' });
    expect(a.detail).toBeTruthy();
  });
});

describe('/api/submit', () => {
  it('saves file, submission and admin token, and logs the attempt with its reference', async () => {
    const db = sqliteD1();
    const r2 = fakeR2();
    const { status, body } = await call(form(), { DB: db, R2: r2 });
    expect(status).toBe(200);
    expect(body.attempt_id).toMatch(/^att_/);
    expect(r2.objects.size).toBe(1);
    expect(await count(db, 'submissions')).toBe(1);
    expect(await count(db, 'submission_tokens')).toBe(1);
    const [a] = await attempts(db);
    expect(a).toMatchObject({ outcome: 'accepted', attempt_id: body.attempt_id, submission_id: body.id });
    expect(a.duration_ms).toEqual(expect.any(Number));
  });

  it('keeps nothing when the file cannot be stored, tells the contributor, and logs why', async () => {
    const db = sqliteD1();
    const { status, body } = await call(form(), { DB: db, R2: fakeR2({ failPut: true }) });
    expect(status).toBe(500);
    expect(String(body.error)).toMatch(/nothing was kept.*try again/i);
    expect(body.attempt_id).toMatch(/^att_/);
    expect(await count(db, 'submissions')).toBe(0);
    const [a] = await attempts(db);
    expect(a).toMatchObject({ outcome: 'rejected', gate: 'persist', step: 'store_file', attempt_id: body.attempt_id });
    expect(String(a.detail)).toMatch(/R2 put failed/);
  });

  it('keeps nothing when the rows cannot be written (file deleted), and logs why', async () => {
    const db = sqliteD1();
    db.raw.exec('DROP TABLE submission_tokens');
    const r2 = fakeR2();
    const { status } = await call(form(), { DB: db, R2: r2 });
    expect(status).toBe(500);
    expect(r2.objects.size).toBe(0);
    expect(await count(db, 'submissions')).toBe(0);
    const [a] = await attempts(db);
    expect(a).toMatchObject({ gate: 'persist', step: 'write_rows', cleanup: 'deleted 1 file(s)' });
    expect(String(a.detail)).toMatch(/submission_tokens/);
  });

  it('logs a malformed request and a missing file, with a reference', async () => {
    const db = sqliteD1();
    const bad = await call('not multipart', { DB: db, R2: fakeR2() });
    const nofile = await call(form({}, null), { DB: db, R2: fakeR2() });
    expect([bad.status, nofile.status]).toEqual([400, 400]);
    expect(bad.body.attempt_id).toMatch(/^att_/);
    expect((await attempts(db)).map((a) => a.gate)).toEqual(['body', 'file']);
  });

  it('logs an unexpected exception (e.g. the database failing mid-validation) with its stack', async () => {
    const db = sqliteD1();
    const flaky = {
      batch: db.batch.bind(db),
      prepare: (sql: string) => {
        if (/rate_limits/.test(sql)) throw new Error('D1_ERROR: database overloaded');
        return db.prepare(sql);
      },
    } as unknown as D1Database;
    const { status, body } = await call(form(), { DB: flaky, R2: fakeR2() });
    expect(status).toBe(500);
    expect(String(body.error)).toMatch(/not saved.*try again/i);
    const [a] = await attempts(db);
    expect(a).toMatchObject({ gate: 'internal', step: 'internal', attempt_id: body.attempt_id });
    expect(String(a.detail)).toMatch(/database overloaded[\s\S]*at /); // message + stack
  });

  it('logs a failed cleanup with the submission id, so orphan files can be found', async () => {
    const db = sqliteD1();
    db.raw.exec('DROP TABLE submission_tokens');
    const r2 = fakeR2({ failDelete: true });
    const { status } = await call(form(), { DB: db, R2: r2 });
    expect(status).toBe(500);
    const [a] = await attempts(db);
    expect(String(a.cleanup)).toMatch(/cleanup failed: R2 delete failed; orphan files: community\//);
    expect(a.submission_id).toEqual(expect.any(String));
    expect(String(a.cleanup)).toContain(String(a.submission_id));
  });

  it('treats a batch that committed before erroring as saved, and logs the warning', async () => {
    const db = sqliteD1();
    const flaky = {
      prepare: db.prepare.bind(db),
      batch: async (stmts: D1PreparedStatement[]) => { await db.batch(stmts); throw new Error('Network connection lost'); },
    } as unknown as D1Database;
    const r2 = fakeR2();
    const { status, body } = await call(form(), { DB: flaky, R2: r2 });
    expect(status).toBe(200);
    expect(r2.objects.size).toBe(1);
    const [a] = await attempts(db);
    expect(a).toMatchObject({ outcome: 'accepted', submission_id: body.id });
    expect(String(a.detail)).toMatch(/committed.*Network connection lost/);
  });

  it('never logs a fragment of the uploaded file when it cannot be parsed', async () => {
    const db = sqliteD1();
    const secret = 'PRIVATE-HOUSEHOLD-NAME';
    const bad = new File([`{"type":"FeatureCollection","features":[ ${secret}`], 'broken.geojson');
    const { status } = await call(form({}, bad), { DB: db, R2: fakeR2() });
    expect(status).toBe(400);
    const [a] = await attempts(db);
    expect(a.gate).toBe('parse');
    expect(String(a.detail)).toMatch(/^SyntaxError/);
    expect(String(a.detail)).not.toContain(secret);
  });

  it('refuses a data year that is not a four-digit year from 1800 to next year', async () => {
    const next = new Date().getUTCFullYear() + 1;
    for (const y of ['20x9', '99', '1799', String(next + 1), '2019.5', '02019']) {
      const db = sqliteD1();
      const r = await call(form({ data_year: y }), { DB: db, R2: fakeR2() });
      expect(r.status, y).toBe(400);
      expect(String(r.body.error), y).toMatch(/data_year/);
      expect(await count(db, 'submissions')).toBe(0);
    }
    const db = sqliteD1();
    expect((await call(form({ data_year: String(next) }), { DB: db, R2: fakeR2() })).status).toBe(200);
    expect(await db.prepare('SELECT data_year FROM submissions').first()).toEqual({ data_year: next });
  });
});
