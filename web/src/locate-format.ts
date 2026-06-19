// Pure formatting for the Find-my-location result sheet (no DOM).
//
// pickFeatureName turns a generic feature's properties into a human title.
// Column names vary per layer, so it's best-effort: a name column wins, then a
// ward/number column rendered as "Ward N", then the first usable string.

const JUNK_KEY = /^_|geom|shape_|shape\.|st_area|st_perimeter|objectid|ogc_fid|\bfid\b|^id$|simptol|simpgnflag/i;

const clean = (v: unknown): string => (v == null ? '' : String(v)).trim();

export function pickFeatureName(props: Record<string, unknown>): string {
  const entries = Object.entries(props).filter(([k, v]) => !JUNK_KEY.test(k) && clean(v) !== '');

  // 1. a "name" column (textual, not a bare numeric code)
  const named = entries.find(([k, v]) => /name/i.test(k) && typeof v !== 'number');
  if (named) return clean(named[1]);

  // 2. a ward / number column -> "Ward N"
  const ward = entries.find(([k]) => /ward.*?(no|num|code)|^no$|number/i.test(k));
  if (ward) return `Ward ${clean(ward[1])}`;

  // 3. first usable string value
  const str = entries.find(([, v]) => typeof v === 'string');
  if (str) return clean(str[1]);

  return 'Found';
}
