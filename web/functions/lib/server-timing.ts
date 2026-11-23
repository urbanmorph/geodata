// Server-Timing phases: where an API answer's time went. The /api/v1 middleware puts
// the rate limit first, a handler adds its own (a point lookup: catalog, lookup,
// profile), and the /api middleware puts the whole chain (api) last.
//
// Read them knowing the Workers clock: Date.now() moves only while the Worker waits
// (for R2, the cache, D1, a timer), never while it computes. A phase is its waiting;
// the CPU it spent decoding is not in it, and shows only as the time to first byte
// minus `api` and the network (or as cpuTime in `wrangler pages deployment tail`).

/** One phase: `name;dur=ms`, in whole milliseconds. */
export const timing = (name: string, ms: number): string => `${name};dur=${Math.round(ms)}`;

/** Adds `before` ahead of the server-timing phases `headers` already has, and `after` behind them. */
export function addTiming(headers: Headers, { before = [], after = [] }: { before?: string[]; after?: string[] }): void {
  const all = [...before, headers.get('server-timing') ?? '', ...after].filter(Boolean);
  if (all.length) headers.set('server-timing', all.join(', '));
}
