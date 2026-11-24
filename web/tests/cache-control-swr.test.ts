// On Cloudflare, `s-maxage` disables `stale-while-revalidate`: a shared cache "must not
// serve stale content without first revalidating" (RFC 9111 proxy-revalidate semantics;
// developers.cloudflare.com/cache/concepts/cache-control/ "Do not use s-maxage with
// stale-while-revalidate"). Functions' Cache-Control set max-age for freshness instead.
// Today Pages keeps no Function answer in the CDN (our own colo cache, edge-cache.ts, keeps
// its own TTLs), so this matters to other shared caches, and to us if a Cache Rule ever
// caches /api.
// (public/_headers pages are not covered here: their CDN-Cache-Control, which the edge
// reads first, carries the edge TTL without s-maxage.)
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../functions/', import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
});

describe('Cache-Control from Functions', () => {
  it('never pairs s-maxage with stale-while-revalidate', () => {
    const bad = files(ROOT).flatMap((f) => (readFileSync(f, 'utf8').match(/['"`][^'"`\n]*s-maxage[^'"`\n]*stale-while-revalidate[^'"`\n]*['"`]/g) ?? [])
      .map((m) => `${f.slice(ROOT.length)}: ${m}`));
    expect(bad).toEqual([]);
  });
});
