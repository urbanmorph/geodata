import { describe, it, expect } from 'vitest';
import { validateNewCollection, validateSchemaDoc } from '../src/schema/validate-collection';

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

  it('caps fields at 20 and reference_layers at 3', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ key: `f${i}`, label: 'x', type: 'text' }));
    expect(validateSchemaDoc({ ...goodSchema, fields: many }).ok).toBe(false);
    expect(validateSchemaDoc({ ...goodSchema, reference_layers: ['a', 'b', 'c', 'd'] }).ok).toBe(false);
  });
});
