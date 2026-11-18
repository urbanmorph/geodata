import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { checkApiRateLimit, apiRateKey, rateKeySource, apiLimit, __resetApiLimiterForTest } from '../functions/lib/api-ratelimit';
import { onRequest as apiMiddleware } from '../functions/api/v1/_middleware';
import { migratedDb, asD1 } from './helpers/sqlite-d1';

afterEach(() => vi.useRealTimers());
beforeEach(() => __resetApiLimiterForTest());

describe('rate-limit key', () => {
  it('groups an IPv6 address by its /64 (one host holds a whole /64)', () => {
    expect(rateKeySource('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateKeySource('2001:DB8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(rateKeySource('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKeySource('::ffff:192.0.2.1')).toBe('0:0:0:0::/64');
    expect(rateKeySource('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('keeps an IPv4 address whole', () => {
    expect(rateKeySource('203.0.113.9')).toBe('203.0.113.9');
  });

  it('salts the hash when IP_SALT is set; unsalted (as before) when not', async () => {
    const req = (ip: string) => new Request('https://bharatlas.com/api/v1/layers', { headers: { 'cf-connecting-ip': ip } });
    const plain = await apiRateKey(req('203.0.113.9'));
    const salted = await apiRateKey(req('203.0.113.9'), 'pepper');
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
    expect(salted).not.toBe(plain);
    expect(await apiRateKey(req('2001:db8:1:2::1'), 's')).toBe(await apiRateKey(req('2001:db8:1:2:ffff::9'), 's'));
    expect(await apiRateKey(req('2001:db8:1:3::1'), 's')).not.toBe(await apiRateKey(req('2001:db8:1:2::1'), 's'));
  });
});

describe('apiLimit: the isolate answers, D1 follows in waitUntil', () => {
  const hangingDb = { prepare: () => ({ bind: () => ({ first: () => new Promise(() => {}) }) }) };
  const overDb = (retryAfterRow = new Date().toISOString()) => ({
    prepare: () => ({ bind: () => ({ first: async () => ({ hour_window_start: retryAfterRow, hour_count: 999 }) }) }),
  });

  it('allows a call without waiting on D1', () => {
    const waited: Promise<unknown>[] = [];
    const r = apiLimit({ db: hangingDb as never, key: 'k1', limit: 120, waitUntil: (p) => { waited.push(p); } });
    expect(r.ok).toBe(true);
    expect(waited).toHaveLength(1); // the D1 bump runs after the answer
  });

  it('a key D1 says is over the limit gets 429 on its next call', async () => {
    const waited: Promise<unknown>[] = [];
    const args = { db: overDb() as never, key: 'k2', limit: 120, waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
    expect(apiLimit(args).ok).toBe(true);
    await Promise.all(waited);
    const r = apiLimit(args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfter).toBeGreaterThan(0);
  });

  it('a burst past the limit on one isolate is refused before D1 answers', () => {
    const args = { db: hangingDb as never, key: 'k3', limit: 5, waitUntil: () => {} };
    const results = Array.from({ length: 8 }, () => apiLimit(args).ok);
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it('the locate limit (60) and the general one (120) are kept apart, as in D1', async () => {
    const waited: Promise<unknown>[] = [];
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ hour_window_start: new Date().toISOString(), hour_count: 90 }) }) }) };
    apiLimit({ db: db as never, key: 'k4', limit: 60, waitUntil: (p) => { waited.push(p); } });
    await Promise.all(waited);
    expect(apiLimit({ db: db as never, key: 'k4', limit: 60, waitUntil: () => {} }).ok).toBe(false);
    expect(apiLimit({ db: db as never, key: 'k4', limit: 120, waitUntil: () => {} }).ok).toBe(true);
  });

  it('a D1 failure blocks nothing', async () => {
    const waited: Promise<unknown>[] = [];
    const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down'); } }) }) };
    apiLimit({ db: broken as never, key: 'k5', limit: 120, waitUntil: (p) => { waited.push(p); } });
    await Promise.all(waited);
    expect(apiLimit({ db: broken as never, key: 'k5', limit: 120, waitUntil: () => {} }).ok).toBe(true);
  });
});

describe('/api/v1 middleware', () => {
  const call = (db: unknown, ip: string, waited: Promise<unknown>[] = []) =>
    apiMiddleware({
      request: new Request('https://bharatlas.com/api/v1/layers', { headers: { 'cf-connecting-ip': ip } }),
      env: { DB: db, IP_SALT: 'pepper' },
      next: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      waitUntil: (p: Promise<unknown>) => { waited.push(p); },
    } as never);

  it('answers without awaiting the D1 bump', async () => {
    const hanging = { prepare: () => ({ bind: () => ({ first: () => new Promise(() => {}) }) }) };
    const r = await Promise.race([call(hanging, '198.51.100.1'), new Promise<string>((res) => setTimeout(() => res('timeout'), 500))]);
    expect(r).not.toBe('timeout');
    expect((r as Response).status).toBe(200);
  });

  it('keeps the 429 contract: status, Retry-After, JSON body', async () => {
    const over = { prepare: () => ({ bind: () => ({ first: async () => ({ hour_window_start: new Date().toISOString(), hour_count: 999 }) }) }) };
    const waited: Promise<unknown>[] = [];
    expect((await call(over, '198.51.100.2', waited)).status).toBe(200);
    await Promise.all(waited);
    const r = await call(over, '198.51.100.2');
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.headers.get('x-api-version')).toBe('v1');
    expect(await r.json()).toMatchObject({ error: 'Rate limit exceeded', status: 429 });
  });
});

describe('checkApiRateLimit (real SQL on the migrated schema)', () => {
  it('allows requests up to the limit, then blocks with a retry-after', async () => {
    const db = asD1(migratedDb());
    for (let i = 0; i < 5; i++) expect((await checkApiRateLimit(db as never, 'ip1', 5)).ok).toBe(true);
    const r = await checkApiRateLimit(db as never, 'ip1', 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfter).toBeGreaterThan(0);
  });

  it('keeps a separate count per IP', async () => {
    const db = asD1(migratedDb());
    for (let i = 0; i < 5; i++) await checkApiRateLimit(db as never, 'ip4', 5);
    expect((await checkApiRateLimit(db as never, 'ip5', 5)).ok).toBe(true);
  });

  it('starts a fresh window after a minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    const db = asD1(migratedDb());
    for (let i = 0; i < 6; i++) await checkApiRateLimit(db as never, 'ip6', 5);
    expect((await checkApiRateLimit(db as never, 'ip6', 5)).ok).toBe(false);
    vi.setSystemTime(new Date('2026-11-15T10:01:01Z'));
    expect((await checkApiRateLimit(db as never, 'ip6', 5)).ok).toBe(true);
  });

  it('is one atomic statement per request (no read-then-write race)', async () => {
    const db = asD1(migratedDb());
    await checkApiRateLimit(db as never, 'ip7', 5);
    await checkApiRateLimit(db as never, 'ip7', 5);
    expect(db.statements).toBe(2);
  });
});
