// Map parsed rows onto the collection's schema and validate each — the same
// checks the API applies (India bounds, declared geometry, field validation).
// Valid rows become records to POST; invalid rows go to the error file.

import { validateRecordProperties, type Field } from '../schema/validate-record';
import { checkIndiaBounds } from '../geo/bounds';
import type { ParsedFeature } from './parse';

export interface Mapping {
  fields: Record<string, string>; // fieldKey -> source column
  lng?: string;                    // CSV point: longitude column
  lat?: string;                    // CSV point: latitude column
}
export interface BuiltRecord { geometry: unknown; properties: Record<string, unknown>; }
export interface ImportError { row: number; error: string; source: Record<string, string>; }
export interface BuildResult { records: BuiltRecord[]; errors: ImportError[]; }

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

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
  features.forEach((f, i) => {
    let geometry = f.geometry as { type?: string } | null;
    if (!geometry && mapping.lng && mapping.lat) {
      const lng = Number(f.props[mapping.lng]);
      const lat = Number(f.props[mapping.lat]);
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
      raw[fl.key] = fl.type === 'multiselect' ? v.split('|').map((s) => s.trim()).filter(Boolean) : v;
    }
    const valid = validateRecordProperties(fields, raw);
    if (!valid.ok) { errors.push({ row: i, error: valid.error, source: f.props }); return; }
    records.push({ geometry, properties: valid.properties });
  });
  return { records, errors };
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
