import { describe, it, expect } from 'vitest';
import { mapConcurrent, R2_CONCURRENCY } from '../functions/lib/concurrency';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('mapConcurrent', () => {
  it('returns results in input order however they finish', async () => {
    const out = await mapConcurrent([30, 5, 20, 1], 3, async (ms, i) => { await tick(ms); return i; });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it('never runs more than `limit` at once, and does run them in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      peak = Math.max(peak, ++inFlight);
      await tick(5);
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it('rejects when a task fails', async () => {
    await expect(mapConcurrent([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }))
      .rejects.toThrow('boom');
  });

  it('caps R2 reads at the Workers simultaneous-connection limit', () => {
    expect(R2_CONCURRENCY).toBe(6);
  });
});
