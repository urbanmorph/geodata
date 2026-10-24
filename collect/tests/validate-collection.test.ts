import { describe, it, expect } from 'vitest';
import { validateNewCollection, validateSchemaDoc, validateCollectionEdit } from '../src/schema/validate-collection';

const goodSchema = {
  version: 1,
  geometry: ['point'],
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'condition', label: 'Condition', type: 'select', options: ['Good', 'Bad'] },
  ],
};

const goodBody = {
  name: '  Bengaluru Footpaths  ',
  purpose: 'Map footpath condition',
  license: 'CC-BY-4.0',
  schema_doc: goodSchema,
};

describe('validateNewCollection', () => {
  it('accepts a valid collection and normalises it', () => {
    const r = validateNewCollection(goodBody);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('Bengaluru Footpaths'); // trimmed
      expect(r.value.license).toBe('CC-BY-4.0');
      expect(JSON.parse(r.value.schema_doc).fields).toHaveLength(2);
      expect(r.value.data_year).toBeNull();
    }
  });

  it('accepts a 200-field form but refuses one too large to store, in plain words', () => {
    const field = (i: number) => ({ key: `f${i}`, label: `Field ${i}`, type: 'select', options: ['Good', 'Moderate', 'Bad'] });
    const big = { ...goodSchema, fields: Array.from({ length: 200 }, (_, i) => field(i)) };
    expect(validateNewCollection({ ...goodBody, schema_doc: big }).ok).toBe(true);
    const huge = { ...goodSchema, fields: [{ key: 'a', label: 'A', type: 'select', options: Array.from({ length: 30000 }, (_, i) => `Option ${i}`) }] };
    const r = validateNewCollection({ ...goodBody, schema_doc: huge });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/form is too large/);
  });

  it('rejects a bad name length', () => {
    expect(validateNewCollection({ ...goodBody, name: 'ab' }).ok).toBe(false);
    expect(validateNewCollection({ ...goodBody, name: 'x'.repeat(121) }).ok).toBe(false);
  });

  it('requires a purpose', () => {
    expect(validateNewCollection({ ...goodBody, purpose: '  ' }).ok).toBe(false);
  });

  it('rejects a non-open licence', () => {
    expect(validateNewCollection({ ...goodBody, license: 'All-Rights-Reserved' }).ok).toBe(false);
  });

  it('accepts and validates data_year', () => {
    const r = validateNewCollection({ ...goodBody, data_year: 2026 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.data_year).toBe(2026);
    expect(validateNewCollection({ ...goodBody, data_year: 3000 }).ok).toBe(false);
  });
});

describe('validateSchemaDoc (the meta-schema check)', () => {
  it('rejects wrong version / empty or unknown geometry', () => {
    expect(validateSchemaDoc({ ...goodSchema, version: 2 }).ok).toBe(false);
    expect(validateSchemaDoc({ ...goodSchema, geometry: [] }).ok).toBe(false);
    expect(validateSchemaDoc({ ...goodSchema, geometry: ['raster'] }).ok).toBe(false);
  });

  it('rejects a bad field key, duplicate key, missing label, bad type', () => {
    expect(validateSchemaDoc({ ...goodSchema, fields: [{ key: 'Bad Key', label: 'x', type: 'text' }] }).ok).toBe(false);
    expect(validateSchemaDoc({ ...goodSchema, fields: [
      { key: 'a', label: 'x', type: 'text' }, { key: 'a', label: 'y', type: 'text' }] }).ok).toBe(false);
    expect(validateSchemaDoc({ ...goodSchema, fields: [{ key: 'a', label: '', type: 'text' }] }).ok).toBe(false);
    expect(validateSchemaDoc({ ...goodSchema, fields: [{ key: 'a', label: 'x', type: 'wysiwyg' }] }).ok).toBe(false);
  });

  it('requires options for select/multiselect', () => {
    expect(validateSchemaDoc({ ...goodSchema, fields: [{ key: 'a', label: 'x', type: 'select' }] }).ok).toBe(false);
    expect(validateSchemaDoc({ ...goodSchema, fields: [{ key: 'a', label: 'x', type: 'select', options: [] }] }).ok).toBe(false);
  });

  it('has no cap on the number of fields (a 22-column survey sheet fits)', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ key: `f${i}`, label: 'x', type: 'text' }));
    expect(validateSchemaDoc({ ...goodSchema, fields: many }).ok).toBe(true);
  });

  it('accepts a Date and time field', () => {
    expect(validateSchemaDoc({ ...goodSchema, fields: [{ key: 'seen', label: 'Seen at', type: 'datetime' }] }).ok).toBe(true);
  });

  it('caps reference_layers at 3', () => {
    expect(validateSchemaDoc({ ...goodSchema, reference_layers: ['a', 'b', 'c', 'd'] }).ok).toBe(false);
  });

  it('accepts a known category, rejects an unknown one', () => {
    expect(validateSchemaDoc({ ...goodSchema, category: 'environment' }).ok).toBe(true);
    expect(validateSchemaDoc({ ...goodSchema, category: 'made-up' }).ok).toBe(false);
  });

  it('accepts a valid basemap + reference_layer, rejects bad ones', () => {
    expect(validateSchemaDoc({ ...goodSchema, basemap: 'satellite' }).ok).toBe(true);
    expect(validateSchemaDoc({ ...goodSchema, basemap: 'streets' }).ok).toBe(false);
    expect(validateSchemaDoc({ ...goodSchema, reference_layer: { id: 'soi_forests', pmtiles_url: 'https://r2.dev/x.pmtiles' } }).ok).toBe(true);
    expect(validateSchemaDoc({ ...goodSchema, reference_layer: { id: 'x', pmtiles_url: 'http://insecure' } }).ok).toBe(false);
    expect(validateSchemaDoc({ ...goodSchema, reference_layer: { id: 'x' } }).ok).toBe(false);
  });
});

describe('validateCollectionEdit', () => {
  const noRecs = { hasRecords: false, currentLicense: 'CC-BY-4.0' };
  it('splits a valid edit into column + schema patches', () => {
    const r = validateCollectionEdit({ name: 'Fixed name', category: 'water', data_year: 2023, description: '' }, noRecs);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.col).toEqual({ name: 'Fixed name', data_year: 2023, description: null });
      expect(r.value.schema).toEqual({ category: 'water' });
    }
  });
  it('rejects a too-short name and an unknown category', () => {
    expect(validateCollectionEdit({ name: 'ab' }, noRecs).ok).toBe(false);
    expect(validateCollectionEdit({ category: 'nope' }, noRecs).ok).toBe(false);
  });
  it('locks the licence once the map has records', () => {
    expect(validateCollectionEdit({ license: 'CC0-1.0' }, { hasRecords: true, currentLicense: 'CC-BY-4.0' }).ok).toBe(false);
    expect(validateCollectionEdit({ license: 'CC0-1.0' }, { hasRecords: false, currentLicense: 'CC-BY-4.0' }).ok).toBe(true);
    expect(validateCollectionEdit({ license: 'CC-BY-4.0' }, { hasRecords: true, currentLicense: 'CC-BY-4.0' }).ok).toBe(true); // same licence ok
  });
  it('clears the reference layer with null, rejects an empty patch', () => {
    const r = validateCollectionEdit({ reference_layer: null }, noRecs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.schema).toEqual({ reference_layer: null });
    expect(validateCollectionEdit({}, noRecs).ok).toBe(false);
  });
});
