// One CSV cell writer for every download: collect's points and "rows not added"
// files, and bharatlas's filtered CSV export. Plain ESM (types in csv.d.mts).

// A text cell starting with one of these runs as a formula in Excel or Sheets
// (CSV injection), so it gets a leading apostrophe. Numbers are left as they are.
const FORMULA_START = /^[=+\-@\t\r]/;

/** A value as one CSV cell: '' for null, a list joined with |, quoted when it
 *  holds a comma, quote or line break, and never a live formula. */
export function csvCell(v) {
  if (v == null) return '';
  let s = Array.isArray(v) ? v.join('|') : String(v);
  if (typeof v !== 'number' && typeof v !== 'bigint' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
