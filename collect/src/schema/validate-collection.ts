// Validate a new collection's metadata + its schema document (the "meta-schema"
// check). Licence must be in the bharatlas-acceptable open set; the schema doc's
// "geometry" array is the single source of truth for allowed geometry types.
// Phase 1 imports isOpenLicence straight from web (promote to shared/ at Phase 2).

import { isOpenLicence } from '../../../web/functions/lib/licenses';
import { validateRecordProperties, type Field } from './validate-record';
import { COLLECT_MODES, MAX_PHOTOS, modeOf, modeProblem, type CollectMode } from './modes';

export const FIELD_TYPES = [
  'text', 'paragraph', 'number', 'select', 'multiselect', 'date', 'datetime', 'url', 'photo',
] as const;
export const GEOMETRY_TYPES = ['point', 'line', 'polygon'] as const;
export const BASEMAP_IDS = ['positron', 'satellite', 'topo'] as const;
// Catalogue facets a published collection can slot into (mirrors catalog.json).
export const CATEGORY_IDS = [
  'boundaries', 'city-wards', 'people', 'environment', 'water',
  'agriculture', 'transport', 'infrastructure', 'culture', 'health-edu', 'other',
] as const;

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const MAX_LABEL = 200;
const MAX_HINT = 500;
// No cap on the number of fields; only on the stored size of the whole form,
// which a D1 row has to hold (a 200-field form is under 20 KB).
const MAX_SCHEMA_BYTES = 256 * 1024;
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

  // Every field is stored as known, typed settings only: unknown keys are
  // dropped, and each kept one is type-checked (they are written into the
  // capture form, so a min of '"><img …>' must never get through).
  const keys = new Set<string>();
  const clean: Record<string, unknown>[] = [];
  for (const f of fields) {
    if (!f || typeof f !== 'object') return fail('each field must be an object');
    const fd = f as Record<string, unknown>;
    if (!isStr(fd.key) || !KEY_RE.test(fd.key)) return fail(`invalid field key: ${String(fd.key)}`);
    if (keys.has(fd.key)) return fail(`duplicate field key: ${fd.key}`);
    keys.add(fd.key);
    if (!isStr(fd.label) || fd.label.trim() === '' || fd.label.length > MAX_LABEL) return fail(`field ${fd.key} needs a label (up to ${MAX_LABEL} characters)`);
    if (!FIELD_TYPES.includes(fd.type as (typeof FIELD_TYPES)[number])) return fail(`field ${fd.key} has invalid type: ${String(fd.type)}`);
    const out: Record<string, unknown> = { key: fd.key, label: fd.label, type: fd.type };
    for (const b of ['required', 'deleted'] as const) {
      if (fd[b] === undefined) continue;
      if (typeof fd[b] !== 'boolean') return fail(`field ${fd.key}: ${b} must be true or false`);
      if (fd[b]) out[b] = true;
    }
    if (fd.hint !== undefined) {
      if (!isStr(fd.hint) || fd.hint.length > MAX_HINT) return fail(`field ${fd.key}: hint must be text up to ${MAX_HINT} characters`);
      if (fd.hint.trim()) out.hint = fd.hint;
    }
    if (fd.type === 'select' || fd.type === 'multiselect') {
      if (!Array.isArray(fd.options) || fd.options.length === 0 || !fd.options.every((o) => isStr(o) && o.length <= MAX_LABEL)) {
        return fail(`field ${fd.key} needs a non-empty options list`);
      }
      out.options = fd.options;
      if (fd.render !== undefined) {
        if (fd.render !== 'chips') return fail(`field ${fd.key}: render must be "chips"`);
        out.render = 'chips';
      }
    } else if (fd.render !== undefined) return fail(`field ${fd.key}: render is only for choices`);
    if (fd.type === 'number') {
      for (const n of ['min', 'max'] as const) {
        if (fd[n] === undefined) continue;
        if (typeof fd[n] !== 'number' || !Number.isFinite(fd[n])) return fail(`field ${fd.key}: ${n} must be a number`);
        out[n] = fd[n];
      }
      if (fd.integer !== undefined) {
        if (typeof fd.integer !== 'boolean') return fail(`field ${fd.key}: integer must be true or false`);
        if (fd.integer) out.integer = true;
      }
    } else if (fd.min !== undefined || fd.max !== undefined) return fail(`field ${fd.key}: min must be a number on a Number field only`);
    if (fd.maxLength !== undefined) {
      if ((fd.type !== 'text' && fd.type !== 'paragraph') || !Number.isInteger(fd.maxLength) || (fd.maxLength as number) < 1 || (fd.maxLength as number) > 5000) {
        return fail(`field ${fd.key}: maxLength must be a whole number 1-5000 on a text field`);
      }
      out.maxLength = fd.maxLength;
    }
    if (fd.type === 'photo') {
      const n = fd.max_photos ?? MAX_PHOTOS;
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_PHOTOS) return fail(`field ${fd.key}: max_photos must be 1 to ${MAX_PHOTOS}`);
      out.max_photos = n;
    } else if (fd.max_photos !== undefined) return fail(`field ${fd.key}: max_photos is only for a Photo question`);
    clean.push(out);
  }

  if (doc.mode !== undefined) {
    if (!COLLECT_MODES.includes(doc.mode as CollectMode)) return fail(`unknown mode: ${String(doc.mode)}`);
    const why = modeProblem(doc.mode as CollectMode, geom as string[], clean as unknown as Field[]);
    if (why) return fail(why);
  }
  if (doc.data_saver !== undefined && typeof doc.data_saver !== 'boolean') return fail('data_saver must be true or false');

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
  return { ok: true, value: { ...doc, fields: clean } };
}

// Validate a partial edit to an existing collection (admin "Edit map settings").
// Returns the column patch (col) + the schema_doc merge (schema). Licence can
// only change while the map has no records; fields/geometry are not editable here.
// The collection mode and Data saver can change any time (the same rules as at create).
export function validateCollectionEdit(
  input: unknown,
  ctx: { hasRecords: boolean; currentLicense: string; schema?: { geometry?: string[]; fields?: Field[] } },
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
  if (b.mode !== undefined) {
    if (!COLLECT_MODES.includes(b.mode as CollectMode)) return fail(`unknown mode: ${String(b.mode)}`);
    const why = modeProblem(b.mode as CollectMode, ctx.schema?.geometry ?? [], ctx.schema?.fields ?? []);
    if (why) return fail(why);
    schema.mode = modeOf({ mode: b.mode });
  }
  if (b.data_saver !== undefined) {
    if (typeof b.data_saver !== 'boolean') return fail('data_saver must be true or false');
    schema.data_saver = b.data_saver;
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
  const schemaDoc = JSON.stringify(sd.value);
  if (!schemaFits(schemaDoc)) {
    return fail(`the form is too large to store (over ${MAX_SCHEMA_BYTES / 1024} KB); shorten its option lists`);
  }

  return {
    ok: true,
    value: { name, purpose, license: b.license, description, data_year: dataYear, schema_doc: schemaDoc },
  };
}

export type FormEditResult =
  | { ok: true; fields: Field[] }
  | { ok: false; error: string; problems?: Array<{ reason: string; count: number }> };

/** A form edit on a map that may already have points (Manage → Edit form). One
 *  rule: every saved point must still be valid under the new form, and no field
 *  is removed once there are points (hide it instead; its data is kept). So
 *  adding options or optional fields always passes; anything that would make a
 *  saved point invalid is refused with how many points and why. */
export function validateFormEdit(
  current: Field[], next: unknown, points: Array<Record<string, unknown>>, geometry: string[], mode?: string,
): FormEditResult {
  const sd = validateSchemaDoc({ version: 1, geometry, fields: next, ...(mode ? { mode } : {}) });
  if (!sd.ok) return sd;
  const fields = sd.value.fields as Field[];
  if (points.length) {
    const keys = new Set(fields.map((f) => f.key));
    const removed = current.find((f) => !keys.has(f.key));
    if (removed) return fail(`"${removed.label}" can't be removed once the map has points; hide it instead (its data is kept)`);
  }
  const problems = new Map<string, number>();
  let broken = 0;
  for (const p of points) {
    const r = validateRecordProperties(fields, p);
    if (!r.ok) { broken++; problems.set(r.error, (problems.get(r.error) ?? 0) + 1); }
  }
  if (broken) {
    return {
      ok: false,
      error: `${broken} point${broken === 1 ? '' : 's'} would no longer fit this form`,
      problems: [...problems].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    };
  }
  return { ok: true, fields };
}

/** Whether a whole form (schema_doc) is small enough to store. */
export function schemaFits(schemaDoc: string): boolean {
  return new TextEncoder().encode(schemaDoc).byteLength <= MAX_SCHEMA_BYTES;
}

