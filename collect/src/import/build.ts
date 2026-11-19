// Map parsed rows onto the collection's schema and validate each — the same
// checks the API applies (India bounds, declared geometry, field validation).
// Valid rows become records to POST; invalid rows go to the error file.

import { validateRecordProperties, type Field } from '../schema/validate-record';
import { checkIndiaBounds } from '../geo/bounds';
import { isDate, datePart } from '../schema/dates';
import type { ParsedFeature } from './parse';

export interface Mapping {
  fields: Record<string, string>; // fieldKey -> source column
  lng?: string;                    // CSV point: longitude column
  lat?: string;                    // CSV point: latitude column
}
export interface BuiltRecord { geometry: unknown; properties: Record<string, unknown>; client_id: string; }
export interface ImportError { row: number; error: string; source: Record<string, string>; }
/** rows[i] is the file row records[i] came from (to trace a server refusal back). */
export interface BuildResult { records: BuiltRecord[]; errors: ImportError[]; rows: number[]; }

/** 64-bit FNV-1a of a string, as 16 hex characters (two 32-bit halves). */
function fnv64(s: string): string {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (a >>> 7);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

const ID_COLUMN = /^id$/i;
const usableId = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' && v.length <= 100 && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : null;

/** A row's client_id: its own id (an "id" column, or a GeoJSON feature id), else
 *  a fingerprint of the row as it is in the file. The server keeps one record per
 *  client_id on a map, so importing the same file again adds nothing. A repeat
 *  of the same id or row gets "~2", "~3"…, so identical rows still each count. */
function rowIdentity(f: ParsedFeature): string {
  const col = Object.keys(f.props).find((k) => ID_COLUMN.test(k));
  return usableId(f.id) ?? usableId(col ? f.props[col] : undefined) ?? `row-${fnv64(JSON.stringify([f.geometry, f.props]))}`;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A file cell as a field value: a pick-many cell splits on |, and a Date field
 *  keeps the date of a date-time (timeDropped says so). Non-strings (values of
 *  saved points) pass through unchanged. */
export function cellValue(field: Field, raw: unknown): { value: unknown; timeDropped?: boolean } {
  if (typeof raw !== 'string') return { value: raw };
  if (field.type === 'multiselect') return { value: raw.split('|').map((s) => s.trim()).filter(Boolean) };
  if (field.type === 'date' && !isDate(raw)) {
    const d = datePart(raw);
    if (d) return { value: d, timeDropped: true };
  }
  return { value: raw };
}

function bucket(t: string): 'point' | 'line' | 'polygon' | null {
  if (t === 'Point' || t === 'MultiPoint') return 'point';
  if (t === 'LineString' || t === 'MultiLineString') return 'line';
  if (t === 'Polygon' || t === 'MultiPolygon') return 'polygon';
  return null;
}

/** Best-guess field↔column + lng/lat mapping by normalized name. */
export function autoMapping(fields: Field[], columns: string[]): Mapping {
  const byNorm = new Map(columns.map((c) => [norm(c), c]));
  const fmap: Record<string, string> = {};
  for (const f of fields) {
    const hit = byNorm.get(norm(f.key)) || byNorm.get(norm(f.label));
    if (hit) fmap[f.key] = hit;
  }
  return {
    fields: fmap,
    lng: byNorm.get('lng') || byNorm.get('lon') || byNorm.get('longitude') || byNorm.get('x'),
    lat: byNorm.get('lat') || byNorm.get('latitude') || byNorm.get('y'),
  };
}

export function buildRecords(
  features: ParsedFeature[],
  mapping: Mapping,
  fields: Field[],
  geometryTypes: string[],
): BuildResult {
  const records: BuiltRecord[] = [];
  const errors: ImportError[] = [];
  const rows: number[] = [];
  const seen = new Map<string, number>();
  features.forEach((f, i) => {
    let geometry = f.geometry as { type?: string } | null;
    if (!geometry && mapping.lng && mapping.lat) {
      // An empty cell is no coordinate (Number('') would be 0, read as off India).
      const cell = (c: string) => (f.props[c] ?? '').trim();
      const lng = cell(mapping.lng) === '' ? NaN : Number(cell(mapping.lng));
      const lat = cell(mapping.lat) === '' ? NaN : Number(cell(mapping.lat));
      if (Number.isFinite(lng) && Number.isFinite(lat)) geometry = { type: 'Point', coordinates: [lng, lat] } as { type: string };
    }
    if (!geometry) { errors.push({ row: i, error: 'no geometry (needs a geometry or lng/lat columns)', source: f.props }); return; }
    const b = checkIndiaBounds(geometry);
    if (!b.ok) { errors.push({ row: i, error: b.error, source: f.props }); return; }
    const gb = bucket(geometry.type || '');
    if (!gb || !geometryTypes.includes(gb)) { errors.push({ row: i, error: `geometry ${geometry.type} not allowed here`, source: f.props }); return; }

    const raw: Record<string, unknown> = {};
    for (const fl of fields) {
      const col = mapping.fields[fl.key];
      if (!col) continue;
      const v = f.props[col];
      if (v == null || v === '') continue;
      raw[fl.key] = cellValue(fl, v).value;
    }
    const valid = validateRecordProperties(fields, raw);
    if (!valid.ok) { errors.push({ row: i, error: valid.error, source: f.props }); return; }
    const base = rowIdentity(f);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    records.push({ geometry, properties: valid.properties, client_id: n === 1 ? base : `${base}~${n}` });
    rows.push(i);
  });
  return { records, errors, rows };
}

/** A CSV of just the rejected rows the author can fix + re-upload: source columns + a `why` column. */
export function errorsToCSV(errors: ImportError[]): string {
  if (!errors.length) return '';
  const cols = [...new Set(errors.flatMap((e) => Object.keys(e.source)))];
  const cell = (v: unknown): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [[...cols, 'why'].map(cell).join(',')];
  for (const e of errors) lines.push([...cols.map((c) => e.source[c] ?? ''), e.error].map(cell).join(','));
  return lines.join('\n');
}
