// Pure review-list helpers. The admin Review tab caches every record once and
// filters/counts them in memory (a filter chip used to re-hit the network on
// each click). Kept framework-free and testable.

type WithStatus = { properties: Record<string, unknown> };

export function statusOf(f: WithStatus): string {
  const s = f.properties._status;
  return typeof s === 'string' && s ? s : 'published';
}

// The active filter's rows. Empty string is the "All" chip and returns the same
// array (no copy), so the common case is free.
export function filterByStatus<T extends WithStatus>(feats: T[], status: string): T[] {
  return status ? feats.filter((f) => statusOf(f) === status) : feats;
}

export function countsOf(feats: WithStatus[]): { published: number; pending: number; rejected: number; total: number } {
  const c = { published: 0, pending: 0, rejected: 0, total: feats.length };
  for (const f of feats) {
    const s = statusOf(f);
    if (s === 'published' || s === 'pending' || s === 'rejected') c[s]++;
  }
  return c;
}
