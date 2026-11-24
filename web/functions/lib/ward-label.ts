// A ward as one summary line ("Ward 49, Shivanasamudra Ward (East Corporation)"), from a
// ward layer's row. Every source names its columns differently; shared/ward_columns.json
// says which is which, read here and by scripts/build_ward_index.py (ward pages), so the
// two never disagree.
import raw from '../../../shared/ward_columns.json';
import { cleanText } from './profile';

/** (number column, name column or null, what the name is: Area, Zone, ... or null). */
type Cols = [string, string | null, string | null];
const config = raw as unknown as {
  columns: Record<string, Cols>; national: Record<string, Cols>;
  parse: Record<string, [string, string, string]>; groups: Record<string, [string, string]>;
  summary: Record<string, string | null>; name_reject: string; number_patterns: string[]; name_patterns: string[];
};
const { columns: COLUMNS, national: NATIONAL, parse: PARSE, groups: GROUPS, summary: SUMMARY } = config;
const NAME_REJECT = new RegExp(config.name_reject, 'i');

/** The value of `col` in `row`, matched without regard to case (as the ward pages read them),
 *  cleaned as the rest of the summary is (cleanText: spaces collapsed, 49.0 as 49). */
function value(row: Record<string, unknown>, col: string | null): string | null {
  if (!col) return null;
  const key = Object.keys(row).find((k) => k.toLowerCase() === col.toLowerCase());
  return key === undefined ? null : cleanText(row[key]);
}

/** A name the ward pages would not show (the number again, a placeholder, a corporation string) is none. */
const realName = (name: string | null | undefined) => (name && !NAME_REJECT.test(name) ? name : null);

/** The first of `patterns` that names a column of `row` (the heuristic for unlisted layers). */
const byPattern = (row: Record<string, unknown>, patterns: string[]) =>
  patterns.find((p) => Object.keys(row).some((k) => k.toLowerCase() === p)) ?? null;

/** Number, name and the name's kind (Area, Zone, ...) of a ward row of layer `id`. */
function parts(id: string, row: Record<string, unknown>): { no: string | null; name: string | null; label: string | null } {
  if (PARSE[id]) {
    const [col, label, pattern] = PARSE[id];
    const m = new RegExp(pattern, 'i').exec(value(row, col) ?? '');
    return m ? { no: m[1] || null, name: realName(m[2]?.trim()), label } : { no: null, name: null, label: null };
  }
  const listed = COLUMNS[id] ?? NATIONAL[id];
  const [noCol, nameCol, label] = listed
    ?? [byPattern(row, config.number_patterns), byPattern(row, config.name_patterns), 'Area'];
  return { no: value(row, noCol), name: realName(value(row, nameCol)), label };
}

/** The summary line for a ward row of layer `id`, or null (left out of the summary, or neither a number nor a name). */
export function wardLine(id: string, row: Record<string, unknown>): string | null {
  if (Object.hasOwn(SUMMARY, id) && SUMMARY[id] === null) return null;
  const unit = SUMMARY[id] ?? 'Ward';
  const p = parts(id, row);
  // A number column that already says it ("Ward 28", Patna) is not said twice.
  const no = p.no?.replace(/^ward\s*(no\.?)?\s*/i, '') || null;
  const { name, label } = p;
  if (!no && !name) return null;
  const head = no ? `${unit} ${no}` : unit;
  // A zone named without the word ("North") says it; most sources' names carry it ("South-West Zone").
  const named = name ? `, ${name}${label === 'Zone' && !/zone/i.test(name) ? ' zone' : ''}` : '';
  const group = GROUPS[id] ? value(row, GROUPS[id][0]) : null;
  return `${head}${named}${group ? ` (${group} ${GROUPS[id][1]})` : ''}`;
}
