/**
 * Workers allow ~6 simultaneous outbound connections per request; R2 range
 * reads beyond that queue anyway. Reading row groups one at a time paid the
 * full R2 latency per group (live Overture filters took ~55 s).
 */
export const R2_CONCURRENCY = 6;

/** Map with at most `limit` tasks in flight; results in input order. */
export async function mapConcurrent<T, R>(
  items: T[], limit: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** At most `limit` holders at a time. `acquire(rank)` resolves with the function that
 *  gives the turn back (calling it again does nothing); a freed turn goes to the lowest
 *  rank waiting, first come among equals. */
export function turns(limit: number): { acquire(rank?: number): Promise<() => void> } {
  let free = limit;
  const waiting: Array<{ rank: number; grant: () => void }> = []; // kept in rank order
  const handBack = () => {
    const next = waiting.shift();
    if (next) next.grant();
    else free++;
  };
  const turn = () => {
    let done = false;
    return () => { if (!done) { done = true; handBack(); } };
  };
  return {
    acquire(rank = 0) {
      if (free > 0) { free--; return Promise.resolve(turn()); }
      return new Promise((r) => {
        const at = waiting.findIndex((w) => w.rank > rank);
        waiting.splice(at < 0 ? waiting.length : at, 0, { rank, grant: () => r(turn()) });
      });
    },
  };
}
