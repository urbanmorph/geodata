import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkApiRateLimit } from '../functions/lib/api-ratelimit';
import { migratedDb, asD1 } from './helpers/sqlite-d1';

afterEach(() => vi.useRealTimers());

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
