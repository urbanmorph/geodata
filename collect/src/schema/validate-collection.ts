// Validate a new collection's metadata + its schema document (the "meta-schema"
// check). Licence must be in the bharatlas-acceptable open set; the schema doc's
// "geometry" array is the single source of truth for allowed geometry types.
// Phase 1 imports isOpenLicence straight from web (promote to shared/ at Phase 2).

import { isOpenLicence } from '../../../web/functions/lib/licenses';

export const FIELD_TYPES = [
  'text', 'paragraph', 'number', 'select', 'multiselect', 'date', 'url',
] as const;
export const GEOMETRY_TYPES = ['point', 'line', 'polygon'] as const;

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const MAX_FIELDS = 20;
const MAX_REF_LAYERS = 3;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface NewCollection {
  name: string;
  purpose: string;
  license: string;
  description: string | null;
  data_year: number | null;
  schema_doc: string; // canonical JSON string
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function validateSchemaDoc(input: unknown): Result<Record<string, unknown>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('schema_doc must be an object');
  const doc = input as Record<string, unknown>;
  if (doc.version !== 1) return fail('schema_doc.version must be 1');

  const geom = doc.geometry;
  if (!Array.isArray(geom) || geom.length === 0) return fail('schema_doc.geometry must be a non-empty array');
  for (const g of geom) {
    if (!GEOMETRY_TYPES.includes(g as (typeof GEOMETRY_TYPES)[number])) return fail(`unknown geometry type: ${String(g)}`);
  }

  const fields = doc.fields;
  if (!Array.isArray(fields)) return fail('schema_doc.fields must be an array');
  if (fields.length > MAX_FIELDS) return fail(`too many fields (max ${MAX_FIELDS})`);

  const keys = new Set<string>();
  for (const f of fields) {
    if (!f || typeof f !== 'object') return fail('each field must be an object');
    const fd = f as Record<string, unknown>;
    if (!isStr(fd.key) || !KEY_RE.test(fd.key)) return fail(`invalid field key: ${String(fd.key)}`);
    if (keys.has(fd.key)) return fail(`duplicate field key: ${fd.key}`);
    keys.add(fd.key);
    if (!isStr(fd.label) || fd.label.trim() === '') return fail(`field ${fd.key} needs a label`);
    if (!FIELD_TYPES.includes(fd.type as (typeof FIELD_TYPES)[number])) return fail(`field ${fd.key} has invalid type: ${String(fd.type)}`);
    if (fd.type === 'select' || fd.type === 'multiselect') {
      if (!Array.isArray(fd.options) || fd.options.length === 0 || !fd.options.every(isStr)) {
        return fail(`field ${fd.key} needs a non-empty options list`);
      }
    }
  }

  const refs = doc.reference_layers;
  if (refs !== undefined) {
    if (!Array.isArray(refs) || !refs.every(isStr)) return fail('reference_layers must be a string array');
    if (refs.length > MAX_REF_LAYERS) return fail(`too many reference layers (max ${MAX_REF_LAYERS})`);
  }
  return { ok: true, value: doc };
}

export function validateNewCollection(input: unknown): Result<NewCollection> {
  if (!input || typeof input !== 'object') return fail('body must be an object');
  const b = input as Record<string, unknown>;

  const name = isStr(b.name) ? b.name.trim() : '';
  if (name.length < 3 || name.length > 120) return fail('name must be 3-120 characters');

  const purpose = isStr(b.purpose) ? b.purpose.trim() : '';
  if (purpose.length < 1 || purpose.length > 2000) return fail('purpose is required');

  if (!isStr(b.license) || !isOpenLicence(b.license)) return fail('license must be an accepted open licence');

  let dataYear: number | null = null;
  if (b.data_year !== undefined && b.data_year !== null && b.data_year !== '') {
    const y = typeof b.data_year === 'number' ? b.data_year : Number(b.data_year);
    if (!Number.isInteger(y) || y < 1800 || y > 2100) return fail('data_year must be a year 1800-2100');
    dataYear = y;
  }

  const description = isStr(b.description) && b.description.trim() !== '' ? b.description.trim() : null;

  const sd = validateSchemaDoc(b.schema_doc);
  if (!sd.ok) return sd;

  return {
    ok: true,
    value: { name, purpose, license: b.license, description, data_year: dataYear, schema_doc: JSON.stringify(sd.value) },
  };
}
