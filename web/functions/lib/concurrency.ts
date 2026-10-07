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
