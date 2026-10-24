// The data check behind the form builder. For one field and a set of values (a
// file's column before "Create", a map's saved points after) it says how many
// fit, why the rest don't, what would be lost, and how often each value is used
// (so options in use can be locked). It runs the same validator the server
// applies to every point, so what the builder allows is what gets saved.

import { validateRecordProperties, type Field } from '../schema/validate-record';
import { cellValue, type ImportError } from './build';

export interface Reason { reason: string; count: number; }
export interface FieldCheck {
  total: number;
  filled: number;
  fit: number;
  problems: Reason[];
  warnings: Reason[];
  /** For pick lists: how many rows use each value (including values not offered). */
  uses: Record<string, number>;
}

const TIME_DROPPED = 'the time is dropped (only the date is kept)';

function tally(map: Map<string, number>, key: string): void { map.set(key, (map.get(key) ?? 0) + 1); }
const ranked = (m: Map<string, number>): Reason[] =>
  [...m].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

const blank = (v: unknown): boolean =>
  v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

export function checkField(field: Field, values: unknown[]): FieldCheck {
  const problems = new Map<string, number>();
  const warnings = new Map<string, number>();
  const uses: Record<string, number> = {};
  const choice = field.type === 'select' || field.type === 'multiselect';
  let filled = 0;
  let fit = 0;
  const prefix = `${field.label} `;
  for (const raw of values) {
    const { value, timeDropped } = cellValue(field, raw);
    if (!blank(value)) {
      filled++;
      if (choice) for (const v of [value].flat()) uses[String(v)] = (uses[String(v)] ?? 0) + 1;
    }
    const r = validateRecordProperties([field], { [field.key]: value });
    if (r.ok) {
      fit++;
      if (timeDropped) tally(warnings, TIME_DROPPED);
    } else {
      // "Surface: "x" is not…" / "Cars must be…": keep only the part after the label.
      const reason = r.error.startsWith(`${field.label}:`) ? r.error.slice(field.label.length + 1).trim()
        : r.error.startsWith(prefix) ? r.error.slice(prefix.length) : r.error;
      tally(problems, reason);
    }
  }
  return { total: values.length, filled, fit, problems: ranked(problems), warnings: ranked(warnings), uses };
}

/** Row errors from buildRecords grouped into reasons with counts, most common first. */
export function summarizeErrors(errors: ImportError[]): Reason[] {
  const m = new Map<string, number>();
  for (const e of errors) tally(m, e.error);
  return ranked(m);
}
