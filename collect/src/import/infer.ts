// "Start a map from a file": discover columns → guess a field per column + the
// geometry, so the schema builder can be pre-filled. Pure + unit-tested. The
// author still reviews/edits before creating; this is a head start, not magic.

import { deriveKey } from '../schema/derive-key';
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

export function guessType(values: string[]): { type: BuilderField['type']; options?: string[] } {
  const vals = values.map((v) => (v ?? '').trim()).filter((v) => v !== '');
  if (!vals.length) return { type: 'text' };
  if (vals.every((v) => v !== '' && !Number.isNaN(Number(v)))) return { type: 'number' };
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v))) return { type: 'date' };
  const distinct = [...new Set(vals)];
  if (distinct.length >= 2 && distinct.length <= 12 && distinct.length <= Math.ceil(vals.length / 2)) {
    return { type: 'select', options: distinct.slice(0, 20) };
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
    const samples = parsed.features.slice(0, 50).map((f) => f.props[col] ?? '');
    const { type, options } = guessType(samples);
    const key = deriveKey(col, used);
    used.push(key);
    const field: BuilderField = { key, label: col, type };
    if (options) field.options = options;
    if (i === 0) field.required = true; // first column is usually the name/id
    fields.push(field);
    mapping[key] = col;
  });
  return { geometry, fields, mapping };
}
