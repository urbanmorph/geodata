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
const PARENT_NAME = /^(st|state|dt|dist|district|sdt|subdist|subdistrict|town|ulb|city|corp|corporation|municipality|zone)[_-]?name$/i;

// A municipal-corporation string some ward layers carry in a name column ("Jaipur (M Corp.) (Part) - Ward No.102"):
// not the ward's own name (scripts/build_ward_index.py NAME_REJECT reads it the same way).
const CORP_STRING = /\(m\.?\s*corp|\(m\s*cl\b/i;

const clean = (v: unknown): string => (v == null ? '' : String(v)).trim();

export function pickFeatureName(props: Record<string, unknown>): string {
  const entries = Object.entries(props).filter(([k, v]) => !JUNK_KEY.test(k) && clean(v) !== '');

  // 1. a "name" column (textual, not a bare numeric code). Prefer the feature's
  //    own name over a parent-admin name; fall back to a parent name only if
  //    that's all there is.
  const named = entries.filter(([k, v]) => /name/i.test(k) && typeof v !== 'number' && !CORP_STRING.test(clean(v)));
  const own = named.find(([k]) => !PARENT_NAME.test(k));
  if (own) return clean(own[1]);

  // 2. a ward / number column -> "Ward N" (a value that already says "Ward 7" stays as it is): a ward's number
  //    beats the name of the town or district it is in
  const ward = entries.find(([k, v]) => /ward.*?(no|num|code|name)|^no$|number/i.test(k) && !CORP_STRING.test(clean(v)));
  if (ward) return /^ward\b/i.test(clean(ward[1])) ? clean(ward[1]) : `Ward ${clean(ward[1])}`;
  if (named.length) return clean(named[0][1]);

  // 3. first usable string value
  const str = entries.find(([, v]) => typeof v === 'string');
  if (str) return clean(str[1]);

  return 'Found';
}

/** The parts of a city's ward-index sidecar (web/public/ward-index/<id>.json) a located ward is read from. */
export type WardSidecar = {
  numberCol?: string;
  /** where the number sits inside a name ("Ward 91 Khairatabad"): the pattern, number in group 1, name in group 2 */
  numberFrom?: string;
  nameLabel?: string | null;
  rows: { no: string; name: string; areas?: string[] }[];
};

/** A located ward's title and the line under it: "Ward 102", then the layer's own name, or the OpenStreetMap areas
 *  (view-only; never part of the layer). null when there is no sidecar or the ward's number is not found in it, so
 *  the caller falls back to pickFeatureName. */
export function wardTitle(props: Record<string, unknown>, idx: WardSidecar | null | undefined): { title: string; sub: string } | null {
  if (!idx?.numberCol || !(idx.numberCol in props)) return null;
  let no = clean(props[idx.numberCol]).replace(/^(-?\d+)\.0+$/, '$1');
  let parsedName = '';
  if (idx.numberFrom) {
    const m = no.match(new RegExp(idx.numberFrom, 'i'));
    if (!m) return null;
    no = m[1];
    parsedName = clean(m[2]);
  }
  const row = idx.rows.find((r) => r.no === no);
  if (!row) return null;
  const sub = row.name || parsedName || (row.areas?.length ? `Areas (OpenStreetMap): ${row.areas.join(', ')}` : '');
  return { title: /^ward\b/i.test(no) ? no : `Ward ${no}`, sub };
}
