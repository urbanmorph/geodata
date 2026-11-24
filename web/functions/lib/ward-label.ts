// A ward as one summary line ("Ward 49, Shivanasamudra Ward (East Corporation)"), from a
// ward layer's row. Every source names its columns differently; shared/ward_columns.json
// says which is which, read here and by scripts/build_ward_index.py (ward pages), so the
// two never disagree.
import raw from '../../../shared/ward_columns.json';

/** (number column, name column or null, what the name is: Area, Zone, ... or null). */
type Cols = [string, string | null, string | null];
const config = raw as unknown as {
  columns: Record<string, Cols>; national: Record<string, Cols>;
  parse: Record<string, [string, string, string]>; groups: Record<string, [string, string]>;
  summary: Record<string, string | null>; name_reject: string; number_patterns: string[]; name_patterns: string[];
};
const { columns: COLUMNS, national: NATIONAL, parse: PARSE, groups: GROUPS, summary: SUMMARY } = config;
const NAME_REJECT = new RegExp(config.name_reject, 'i');

/** The value of `col` in `row`, matched without regard to case (as the ward pages read them). */
function value(row: Record<string, unknown>, col: string | null): string | null {
  if (!col) return null;
  const key = Object.keys(row).find((k) => k.toLowerCase() === col.toLowerCase());
  const v = key === undefined ? null : row[key];
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

/** The first of `patterns` that names a column of `row` (the heuristic for unlisted layers). */
const byPattern = (row: Record<string, unknown>, patterns: string[]) =>
  patterns.find((p) => Object.keys(row).some((k) => k.toLowerCase() === p)) ?? null;

/** Number, name and the name's kind (Area, Zone, ...) of a ward row of layer `id`. */
function parts(id: string, row: Record<string, unknown>): { no: string | null; name: string | null; label: string | null } {
  if (PARSE[id]) {
    const [col, label, pattern] = PARSE[id];
    const m = new RegExp(pattern, 'i').exec(value(row, col) ?? '');
    return m ? { no: m[1] || null, name: m[2]?.trim() || null, label } : { no: null, name: null, label: null };
  }
  const listed = COLUMNS[id] ?? NATIONAL[id];
  const [noCol, nameCol, label] = listed
    ?? [byPattern(row, config.number_patterns), byPattern(row, config.name_patterns), 'Area'];
  const name = value(row, nameCol);
  return { no: value(row, noCol), name: name && !NAME_REJECT.test(name) ? name : null, label };
}

/** The summary line for a ward row of layer `id`, or null (left out of the summary, or neither a number nor a name). */
export function wardLine(id: string, row: Record<string, unknown>): string | null {
  if (Object.hasOwn(SUMMARY, id) && SUMMARY[id] === null) return null;
  const unit = SUMMARY[id] ?? 'Ward';
  const { no, name, label } = parts(id, row);
  if (!no && !name) return null;
  const head = no ? `${unit} ${no}` : unit;
  const named = name ? `, ${name}${label === 'Zone' ? ' zone' : ''}` : '';
  const group = GROUPS[id] ? value(row, GROUPS[id][0]) : null;
  return `${head}${named}${group ? ` (${group} ${GROUPS[id][1]})` : ''}`;
}
