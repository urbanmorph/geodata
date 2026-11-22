// schemaOf: a map's stored schema_doc, parsed once with one type.
import { describe, it, expect } from 'vitest';
import { schemaOf } from '../../functions/lib/db';

describe('schemaOf', () => {
  it('parses the stored schema_doc, keeping every key', () => {
    const doc = { version: 1, geometry: ['point'], fields: [{ key: 'name', label: 'Name', type: 'text' }], mode: 'form', category: 'trees' };
    const s = schemaOf({ schema_doc: JSON.stringify(doc) });
    expect(s).toEqual(doc);
    expect(s.fields[0].key).toBe('name');
  });

  it('gives a fresh object each call, so a caller may change it', () => {
    const row = { schema_doc: '{"geometry":["point"],"fields":[]}' };
    const a = schemaOf(row);
    a.geometry.push('line');
    expect(schemaOf(row).geometry).toEqual(['point']);
  });
});
