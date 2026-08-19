// Validate a new collection's metadata + its schema document (the "meta-schema"
// check). Licence must be in the bharatlas-acceptable open set; the schema doc's
// "geometry" array is the single source of truth for allowed geometry types.
// Phase 1 imports isOpenLicence straight from web (promote to shared/ at Phase 2).

import { isOpenLicence } from '../../../web/functions/lib/licenses';

export const FIELD_TYPES = [
  'text', 'paragraph', 'number', 'select', 'multiselect', 'date', 'url',
] as const;
export const GEOMETRY_TYPES = ['point', 'line', 'polygon'] as const;
export const BASEMAP_IDS = ['positron', 'satellite', 'topo'] as const;
// Catalogue facets a published collection can slot into (mirrors catalog.json).
export const CATEGORY_IDS = [
  'boundaries', 'city-wards', 'people', 'environment', 'water',
  'agriculture', 'transport', 'infrastructure', 'culture', 'health-edu', 'other',
] as const;

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

  if (doc.category !== undefined && !CATEGORY_IDS.includes(doc.category as (typeof CATEGORY_IDS)[number])) {
    return fail(`unknown category: ${String(doc.category)}`);
  }

  // Map options (Phase 4/5): an author-chosen basemap + one bharatlas overlay.
  if (doc.basemap !== undefined && !BASEMAP_IDS.includes(doc.basemap as (typeof BASEMAP_IDS)[number])) {
    return fail(`unknown basemap: ${String(doc.basemap)}`);
  }
  const ref = doc.reference_layer;
  if (ref !== undefined && ref !== null) {
    if (typeof ref !== 'object' || Array.isArray(ref)) return fail('reference_layer must be an object');
    const r = ref as Record<string, unknown>;
    if (!isStr(r.id) || !isStr(r.pmtiles_url) || !r.pmtiles_url.startsWith('https://')) {
      return fail('reference_layer needs id and an https pmtiles_url');
    }
  }
  return { ok: true, value: doc };
}

// Validate a partial edit to an existing collection (admin "Edit map settings").
// Returns the column patch (col) + the schema_doc merge (schema). Licence can
// only change while the map has no records; fields/geometry are not editable here.
export function validateCollectionEdit(
  input: unknown,
  ctx: { hasRecords: boolean; currentLicense: string },
): Result<{ col: Record<string, unknown>; schema: Record<string, unknown> }> {
  if (!input || typeof input !== 'object') return fail('body must be an object');
  const b = input as Record<string, unknown>;
  const col: Record<string, unknown> = {};
  const schema: Record<string, unknown> = {};

  if (b.name !== undefined) {
    const name = isStr(b.name) ? b.name.trim() : '';
    if (name.length < 3 || name.length > 120) return fail('name must be 3-120 characters');
    col.name = name;
  }
  if (b.purpose !== undefined) {
    const p = isStr(b.purpose) ? b.purpose.trim() : '';
    if (p.length < 1 || p.length > 2000) return fail('purpose is required');
    col.purpose = p;
  }
  if (b.description !== undefined) {
    const d = isStr(b.description) ? b.description.trim() : '';
    if (d.length > 2000) return fail('description is too long');
    col.description = d === '' ? null : d;
  }
  if (b.data_year !== undefined) {
    if (b.data_year === null || b.data_year === '') col.data_year = null;
    else {
      const y = typeof b.data_year === 'number' ? b.data_year : Number(b.data_year);
      if (!Number.isInteger(y) || y < 1800 || y > 2100) return fail('data_year must be a year 1800-2100');
      col.data_year = y;
    }
  }
  if (b.license !== undefined) {
    if (!isStr(b.license) || !isOpenLicence(b.license)) return fail('license must be an accepted open licence');
    if (ctx.hasRecords && b.license !== ctx.currentLicense) return fail('the licence is locked once the map has points');
    col.license = b.license;
  }
  if (b.category !== undefined) {
    if (!CATEGORY_IDS.includes(b.category as (typeof CATEGORY_IDS)[number])) return fail(`unknown category: ${String(b.category)}`);
    schema.category = b.category;
  }
  if (b.basemap !== undefined) {
    if (!BASEMAP_IDS.includes(b.basemap as (typeof BASEMAP_IDS)[number])) return fail(`unknown basemap: ${String(b.basemap)}`);
    schema.basemap = b.basemap;
  }
  if (b.reference_layer !== undefined) {
    if (b.reference_layer === null) schema.reference_layer = null;
    else {
      const r = b.reference_layer as Record<string, unknown>;
      if (typeof r !== 'object' || Array.isArray(r) || !isStr(r.id) || !isStr(r.pmtiles_url) || !r.pmtiles_url.startsWith('https://')) {
        return fail('reference_layer needs id and an https pmtiles_url');
      }
      schema.reference_layer = { id: r.id, pmtiles_url: r.pmtiles_url };
    }
  }
  if (Object.keys(col).length === 0 && Object.keys(schema).length === 0) return fail('nothing to update');
  return { ok: true, value: { col, schema } };
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
