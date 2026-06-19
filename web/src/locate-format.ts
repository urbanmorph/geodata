// Pure formatting for the Find-my-location result sheet (no DOM).
//
// pickFeatureName turns a generic feature's properties into a human title.
// Column names vary per layer, so it's best-effort: a name column wins, then a
// ward/number column rendered as "Ward N", then the first usable string.

const JUNK_KEY = /^_|geom|shape_|shape\.|st_area|st_perimeter|objectid|ogc_fid|\bfid\b|^id$|simptol|simpgnflag/i;

// Parent-admin name columns (st_name, dist_name, dtname, sdtname …). A feature
// often carries these before its own name — e.g. an assembly constituency has
// st_name="KARNATAKA" before ac_name="Shivajinagar" — and "you're in KARNATAKA"
// is useless. Deprioritise them; only fall back to one when it IS the feature
// (a district/state layer whose only name column is dtname/stname).
const PARENT_NAME = /^(st|state|dt|dist|district|sdt|subdist|subdistrict)[_-]?name$/i;

const clean = (v: unknown): string => (v == null ? '' : String(v)).trim();

export function pickFeatureName(props: Record<string, unknown>): string {
  const entries = Object.entries(props).filter(([k, v]) => !JUNK_KEY.test(k) && clean(v) !== '');

  // 1. a "name" column (textual, not a bare numeric code). Prefer the feature's
  //    own name over a parent-admin name; fall back to a parent name only if
  //    that's all there is.
  const named = entries.filter(([k, v]) => /name/i.test(k) && typeof v !== 'number');
  const own = named.find(([k]) => !PARENT_NAME.test(k));
  if (own) return clean(own[1]);
  if (named.length) return clean(named[0][1]);

  // 2. a ward / number column -> "Ward N"
  const ward = entries.find(([k]) => /ward.*?(no|num|code)|^no$|number/i.test(k));
  if (ward) return `Ward ${clean(ward[1])}`;

  // 3. first usable string value
  const str = entries.find(([, v]) => typeof v === 'string');
  if (str) return clean(str[1]);

  return 'Found';
}
