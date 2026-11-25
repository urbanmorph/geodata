// Features a source repeats (bharatviz_pincodes has every polygon twice) are answered once.
type Props = Record<string, unknown>;

/** A feature's properties as a key: key order does not matter, bigints read as numbers. */
const canonical = (p: Props) => JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]),
  (_k, v) => (typeof v === 'bigint' ? Number(v) : v));

/** Features with identical properties, once. */
export function dedupeFeatures<P extends Props>(features: P[]): P[] {
  const seen = new Set<string>();
  return features.filter((f) => {
    const key = canonical(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
