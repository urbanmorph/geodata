import { describe, it, expect } from 'vitest';
import { validateRecordProperties, type Field } from '../src/schema/validate-record';

const fields: Field[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'condition', label: 'Condition', type: 'select', options: ['Good', 'Bad'] },
  { key: 'width', label: 'Width', type: 'number', min: 0, integer: true },
  { key: 'services', label: 'Services', type: 'multiselect', options: ['a', 'b', 'c'] },
  { key: 'surveyed', label: 'Surveyed', type: 'date' },
  { key: 'ref', label: 'Ref', type: 'url' },
  { key: 'gone', label: 'Removed', type: 'text', deleted: true },
];

describe('validateRecordProperties', () => {
  it('accepts a valid record and returns cleaned properties', () => {
    const r = validateRecordProperties(fields, {
      name: 'Kaveri footpath', condition: 'Good', width: 3, services: ['a', 'b'],
      surveyed: '2026-08-14', ref: 'https://example.org/x',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.properties).toEqual({
      name: 'Kaveri footpath', condition: 'Good', width: 3, services: ['a', 'b'],
      surveyed: '2026-08-14', ref: 'https://example.org/x',
    });
  });

  it('rejects when a required field is missing or empty', () => {
    expect(validateRecordProperties(fields, { condition: 'Good' }).ok).toBe(false);
    expect(validateRecordProperties(fields, { name: '   ' }).ok).toBe(false);
  });

  it('rejects a select value not in options', () => {
    expect(validateRecordProperties(fields, { name: 'x', condition: 'Ugly' }).ok).toBe(false);
  });

  it('coerces a numeric string but rejects non-numeric, and enforces integer/min', () => {
    const ok = validateRecordProperties(fields, { name: 'x', width: '5' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.properties.width).toBe(5);
    expect(validateRecordProperties(fields, { name: 'x', width: 'wide' }).ok).toBe(false);
    expect(validateRecordProperties(fields, { name: 'x', width: 2.5 }).ok).toBe(false); // integer
    expect(validateRecordProperties(fields, { name: 'x', width: -1 }).ok).toBe(false);  // min 0
  });

  it('rejects a multiselect value outside options', () => {
    expect(validateRecordProperties(fields, { name: 'x', services: ['a', 'z'] }).ok).toBe(false);
  });

  it('rejects a bad date and a non-http url', () => {
    expect(validateRecordProperties(fields, { name: 'x', surveyed: '14-08-2026' }).ok).toBe(false);
    expect(validateRecordProperties(fields, { name: 'x', ref: 'javascript:alert(1)' }).ok).toBe(false);
  });

  it('drops unknown keys and omits soft-deleted field values', () => {
    const r = validateRecordProperties(fields, { name: 'x', bogus: 1, gone: 'stale' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.properties).toEqual({ name: 'x' });
      expect('bogus' in r.properties).toBe(false);
      expect('gone' in r.properties).toBe(false);
    }
  });

  it('rejects non-object input', () => {
    expect(validateRecordProperties(fields, null).ok).toBe(false);
    expect(validateRecordProperties(fields, 'x').ok).toBe(false);
  });
});
