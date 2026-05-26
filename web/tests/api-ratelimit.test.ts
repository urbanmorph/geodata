import { describe, it, expect } from 'vitest';
import { checkApiRateLimit } from '../functions/lib/api-ratelimit';

function fakeD1() {
  const rows = new Map<string, { hour_window_start: string; hour_count: number }>();
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) { args = a; return this; },
        async first() {
          if (/SELECT/.test(sql)) return rows.get(args[0] as string) || null;
          return null;
        },
        async run() {
          if (/INSERT/.test(sql)) {
            const key = args[0] as string;
            rows.set(key, { hour_window_start: args[1] as string, hour_count: args[2] as number });
          } else if (/UPDATE/.test(sql)) {
            const key = args[2] as string;
            rows.set(key, { hour_window_start: args[0] as string, hour_count: args[1] as number });
          }
          return { success: true };
        },
      };
    },
  };
}

describe('checkApiRateLimit', () => {
  it('allows first request', async () => {
    const db = fakeD1();
    const r = await checkApiRateLimit(db as never, 'ip1', 5);
    expect(r.ok).toBe(true);
  });

  it('allows requests up to the limit', async () => {
    const db = fakeD1();
    for (let i = 0; i < 5; i++) {
      const r = await checkApiRateLimit(db as never, 'ip2', 5);
      expect(r.ok).toBe(true);
    }
  });

  it('blocks after exceeding the limit', async () => {
    const db = fakeD1();
    for (let i = 0; i < 5; i++) {
      await checkApiRateLimit(db as never, 'ip3', 5);
    }
    const r = await checkApiRateLimit(db as never, 'ip3', 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfter).toBeGreaterThan(0);
  });

  it('uses separate keys per IP', async () => {
    const db = fakeD1();
    for (let i = 0; i < 5; i++) {
      await checkApiRateLimit(db as never, 'ip4', 5);
    }
    const r = await checkApiRateLimit(db as never, 'ip5', 5);
    expect(r.ok).toBe(true);
  });
});
