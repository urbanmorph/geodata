// "Start a map from a file": discover columns → guess a field per column + the
// geometry, so the schema builder can be pre-filled. Pure + unit-tested. The
// author still reviews/edits before creating; this is a head start, not magic.

import { deriveKey } from '../schema/derive-key';
import { isDate, normalizeDateTime, looksLikeLocalDate } from '../schema/dates';
import type { Parsed } from './parse';
import type { BuilderField } from '../schema-builder';

// Columns that describe location, not an attribute — never become fields.
const COORD_KEYS = new Set(['lng', 'lon', 'long', 'longitude', 'x', 'lat', 'latitude', 'y', 'geometry', 'geom', 'wkt', 'thegeom', 'coordinates']);

export interface Inferred {
  geometry: string[];
  fields: BuilderField[];
  mapping: Record<string, string>; // fieldKey -> source column
}

function bucket(t?: string): string | null {
  if (t === 'Point' || t === 'MultiPoint') return 'point';
  if (t === 'LineString' || t === 'MultiLineString') return 'line';
  if (t === 'Polygon' || t === 'MultiPolygon') return 'polygon';
  return null;
}

// A column becomes a pick list only when it clearly repeats a set of values: up
// to SMALL_LIST distinct ones used about twice each, or up to MAX_CHOICES when
// each is used at least LONG_LIST_USES times on average. Anything else stays
// text, so contributors can still type a value the file didn't have (a new
// street, a new shop): a wrong pick list blocks them, a wrong text field doesn't.
const SMALL_LIST = 12;
const MAX_CHOICES = 40;
const LONG_LIST_USES = 5;
const choiceList = (items: string[]): string[] | null => {
  const distinct = [...new Set(items)];
  const d = distinct.length;
  const repeats = d >= 2 && d <= Math.ceil(items.length / 2);
  return repeats && (d <= SMALL_LIST || (d <= MAX_CHOICES && items.length / d >= LONG_LIST_USES)) ? distinct : null;
};

export function guessType(values: string[]): { type: BuilderField['type']; options?: string[]; note?: string } {
  const vals = values.map((v) => (v ?? '').trim()).filter((v) => v !== '');
  if (!vals.length) return { type: 'text' };
  if (vals.every((v) => !Number.isNaN(Number(v)))) return { type: 'number' };
  if (vals.every(isDate)) return { type: 'date' };
  if (vals.every((v) => isDate(v) || normalizeDateTime(v))) return { type: 'datetime' };
  if (vals.every((v) => /^https?:\/\/\S+$/i.test(v))) return { type: 'url' };
  if (vals.every(looksLikeLocalDate)) {
    return { type: 'text', note: 'These look like dates, but the day and month order is unclear (04/05 could be 4 May or 5 April). Rewrite them as YYYY-MM-DD in the file to use a Date field.' };
  }
  if (vals.some((v) => v.includes('|'))) {
    const opts = choiceList(vals.flatMap((v) => v.split('|').map((s) => s.trim()).filter(Boolean)));
    if (opts) return { type: 'multiselect', options: opts };
  } else {
    const opts = choiceList(vals);
    if (opts) return { type: 'select', options: opts };
  }
  const maxLen = Math.max(...vals.map((v) => v.length));
  if (maxLen > 80) return { type: 'paragraph' };
  return { type: 'text' };
}

export function inferSchema(parsed: Parsed, format: string): Inferred {
  let geometry: string[];
  if (format === 'csv') geometry = ['point'];
  else {
    const set = new Set<string>();
    for (const f of parsed.features) { const b = bucket((f.geometry as { type?: string } | null)?.type); if (b) set.add(b); }
    geometry = set.size ? [...set] : ['point'];
  }

  const dataCols = parsed.columns.filter((c) => !COORD_KEYS.has(c.toLowerCase().replace(/[^a-z]/g, '')));
  const fields: BuilderField[] = [];
  const mapping: Record<string, string> = {};
  const used: string[] = [];
  dataCols.forEach((col, i) => {
    // Every row, not a sample: a choice list guessed from the first rows refuses
    // values that only appear further down (e.g. a group that starts at row 51).
    const { type, options, note } = guessType(parsed.features.map((f) => f.props[col] ?? ''));
    const key = deriveKey(col, used);
    used.push(key);
    const field: BuilderField = { key, label: col, type };
    if (options) field.options = options;
    if (note) field.note = note;
    if (i === 0) field.required = true; // first column is usually the name/id
    fields.push(field);
    mapping[key] = col;
  });
  return { geometry, fields, mapping };
}
