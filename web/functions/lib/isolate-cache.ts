// Caches that live for the life of a Worker isolate, shared by its requests.
//
// Only RESOLVED values are shared across requests. Workers cancels the I/O a
// request started once that request ends, and a promise left behind never
// settles ("This promise was created by a request that has since ended, so it
// can never settle"). A cache that kept such a pending promise made every later
// request for that key wait until the platform limit (~60 s on /api/v1/nearby).

/**
 * Loads in flight by key, shared only among callers passing the same `scope` (the
 * request, or an object that lives only as long as it); nothing is kept once a load
 * settles, so a rejected load is never handed to a later caller.
 */
export class InflightShare<V> {
  private inflight = new WeakMap<object, Map<string, Promise<V>>>();

  get(key: string, load: () => Promise<V>, scope?: object): Promise<V> {
    if (!scope) return load();
    let mine = this.inflight.get(scope);
    const shared = mine?.get(key);
    if (shared) return shared;
    if (!mine) this.inflight.set(scope, (mine = new Map()));
    const p = load();
    const own = mine;
    own.set(key, p);
    p.finally(() => own.delete(key)).catch(() => {});
    return p;
  }

  clear(): void {
    this.inflight = new WeakMap();
  }
}

/**
 * Values by key, least recently used out past `max`. A load in flight is
 * shared only with callers passing the same `scope` (the request, or an object
 * that lives only as long as it); a rejected load is not kept.
 */
export class ResolvedCache<V> {
  private values = new Map<string, V>();
  private inflight = new InflightShare<V>();

  constructor(private readonly max = Infinity) {}

  get(key: string, load: () => Promise<V>, scope?: object): Promise<V> {
    if (this.values.has(key)) {
      const v = this.values.get(key)!;
      this.values.delete(key);
      this.values.set(key, v); // most recently used last
      return Promise.resolve(v);
    }
    return this.inflight.get(key, () => load().then((v) => {
      this.values.set(key, v);
      while (this.values.size > this.max) this.values.delete(this.values.keys().next().value!);
      return v;
    }), scope);
  }

  clear(): void {
    this.values.clear();
    this.inflight.clear();
  }
}

/** Resolved values by key, least recently used out once their sizes pass `maxBytes`. */
export class ByteLru<V> {
  private values = new Map<string, { v: V; size: number }>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  /** The value (now most recently used), or undefined when not kept. */
  get(key: string): V | undefined {
    const hit = this.values.get(key);
    if (!hit) return undefined;
    this.values.delete(key);
    this.values.set(key, hit);
    return hit.v;
  }

  set(key: string, v: V, size: number): void {
    this.values.set(key, { v, size });
    this.bytes += size;
    for (const [k, e] of this.values) {
      if (this.bytes <= this.maxBytes) break;
      this.values.delete(k);
      this.bytes -= e.size;
    }
  }

  clear(): void {
    this.values.clear();
    this.bytes = 0;
  }
}

/** Generous bound on one R2 read: a stuck read fails with a clear error
 *  instead of holding the request until the platform limit. */
export const READ_TIMEOUT_MS = 20_000;

/** `p`, or a rejection naming `what` if it hasn't settled within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>; // set synchronously below
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
